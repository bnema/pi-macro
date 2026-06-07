import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Macro, MacroFile } from "./types.js";

export const MACRO_FILE_VERSION = 1;
export const MACRO_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export interface CreateMacroInput {
  name: string;
  description?: string;
  body: string;
}

export type UpdateMacroPatch = Partial<Pick<Macro, "name" | "description" | "body">>;

interface Snapshot {
  path: string;
  file: MacroFile;
  hash: string;
  mtimeMs: number | null;
}

type Mutation =
  | { type: "create"; input: CreateMacroInput }
  | { type: "update"; name: string; patch: UpdateMacroPatch }
  | { type: "delete"; name: string }
  | { type: "duplicate"; source: string; target: string };

export class MacroStoreError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "MacroStoreError";
  }
}

export function resolveMacroFilePath(env: NodeJS.ProcessEnv = process.env): string {
  return env.PI_MACRO_FILE && env.PI_MACRO_FILE.trim() !== ""
    ? path.resolve(env.PI_MACRO_FILE)
    : path.join(os.homedir(), ".pi", "macro", "macros.json");
}

export function isValidMacroName(name: string): boolean {
  return MACRO_NAME_PATTERN.test(name);
}

function assertValidName(name: string): void {
  if (!isValidMacroName(name)) {
    throw new MacroStoreError(`Invalid macro name: ${name}. Use ${MACRO_NAME_PATTERN.source}.`, "invalid-name");
  }
}

function normalizeName(name: string): string {
  return name.toLowerCase();
}

let lastTimestampMs = 0;

function nowIso(): string {
  const current = Date.now();
  const next = current <= lastTimestampMs ? lastTimestampMs + 1 : current;
  lastTimestampMs = next;
  return new Date(next).toISOString();
}

function stableHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function hashFile(file: MacroFile): string {
  return stableHash(JSON.stringify(file));
}

function macroHash(macro: Macro | undefined): string | undefined {
  return macro ? stableHash(JSON.stringify(macro)) : undefined;
}

function cloneFile(file: MacroFile): MacroFile {
  return JSON.parse(JSON.stringify(file)) as MacroFile;
}

function validateMacroFile(value: unknown, source: string): MacroFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MacroStoreError(`Invalid macro file at ${source}: expected object.`, "invalid-shape");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== MACRO_FILE_VERSION) {
    throw new MacroStoreError(`Unsupported macro file version at ${source}: ${String(candidate.version)}.`, "read-only-version");
  }
  if (!Array.isArray(candidate.macros)) {
    throw new MacroStoreError(`Invalid macro file at ${source}: macros must be an array.`, "invalid-shape");
  }
  const seen = new Set<string>();
  for (const item of candidate.macros) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new MacroStoreError(`Invalid macro entry at ${source}.`, "invalid-shape");
    const macro = item as Record<string, unknown>;
    if (typeof macro.name !== "string" || typeof macro.body !== "string" || typeof macro.createdAt !== "string" || typeof macro.updatedAt !== "string") {
      throw new MacroStoreError(`Invalid macro entry at ${source}: missing required string fields.`, "invalid-shape");
    }
    if (macro.description !== undefined && typeof macro.description !== "string") throw new MacroStoreError(`Invalid macro entry at ${source}: description must be a string.`, "invalid-shape");
    assertValidName(macro.name);
    if (macro.body.length === 0) throw new MacroStoreError(`Macro ${macro.name} has an empty body.`, "empty-body");
    const lower = normalizeName(macro.name);
    if (seen.has(lower)) throw new MacroStoreError(`Duplicate macro name in ${source}: ${macro.name}.`, "duplicate-name");
    seen.add(lower);
  }
  return value as MacroFile;
}

async function statMtimeMs(filePath: string): Promise<number | null> {
  try { return (await fs.stat(filePath)).mtimeMs; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function loadMacroFile(filePath = resolveMacroFilePath()): Promise<MacroFile> {
  return (await readSnapshot(filePath)).file;
}

async function readSnapshot(filePath: string): Promise<Snapshot> {
  try {
    const text = await fs.readFile(filePath, "utf8");
    const parsed = validateMacroFile(JSON.parse(text), filePath);
    return { path: filePath, file: parsed, hash: hashFile(parsed), mtimeMs: await statMtimeMs(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const file: MacroFile = { version: 1, macros: [] };
      return { path: filePath, file, hash: hashFile(file), mtimeMs: null };
    }
    if (error instanceof SyntaxError) throw new MacroStoreError(`Malformed JSON in macro file ${filePath}: ${error.message}`, "malformed-json");
    throw error;
  }
}

async function writeAtomic(filePath: string, file: MacroFile): Promise<void> {
  validateMacroFile(file, filePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const tempPath = path.join(path.dirname(filePath), `.macros.${process.pid}.${randomUUID()}.tmp`);
  const data = `${JSON.stringify(file, null, 2)}\n`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(tempPath, "w", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(tempPath, filePath);
    try { await fs.chmod(filePath, 0o600); } catch { /* best effort */ }
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  const stat = await fs.stat(lockPath);
  if (Date.now() - stat.mtimeMs > 30_000) return true;
  const [pidLine] = (await fs.readFile(lockPath, "utf8").catch(() => "")).split("\n");
  const pid = Number(pidLine);
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function withWriteLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const lockPath = `${filePath}.lock`;
  const start = Date.now();
  let handle: fs.FileHandle | undefined;
  while (!handle) {
    try {
      handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = await isStaleLock(lockPath).catch(() => false);
      if (stale) {
        await fs.unlink(lockPath).catch(() => undefined);
        continue;
      }
      if (Date.now() - start > 10_000) throw new MacroStoreError(`Timed out waiting for macro file lock: ${filePath}.`, "lock-timeout");
      await sleep(10);
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    try { await fs.unlink(lockPath); } catch { /* best effort */ }
  }
}

export interface SaveMacroFileOptions {
  expectedHash?: string;
  allowOverwrite?: boolean;
}

async function guardedSaveMacroFile(filePath: string, file: MacroFile, options: SaveMacroFileOptions = {}): Promise<void> {
  await withWriteLock(filePath, async () => {
    const current = await readSnapshot(filePath);
    const nextHash = hashFile(file);
    if (!options.allowOverwrite && current.mtimeMs !== null && current.hash !== nextHash && current.hash !== options.expectedHash) {
      throw new MacroStoreError("Macro file changed concurrently; refusing to overwrite without an expected snapshot.", "concurrent-conflict");
    }
    await writeAtomic(filePath, file);
  });
}

function findIndex(file: MacroFile, name: string): number {
  const lower = normalizeName(name);
  return file.macros.findIndex((macro) => normalizeName(macro.name) === lower);
}

function requireMacro(file: MacroFile, name: string): Macro {
  const macro = file.macros[findIndex(file, name)];
  if (!macro) throw new MacroStoreError(`Macro not found: ${name}.`, "not-found");
  return macro;
}

function ensureUnique(file: MacroFile, name: string, except?: string): void {
  const lower = normalizeName(name);
  const exceptLower = except ? normalizeName(except) : undefined;
  if (file.macros.some((m) => normalizeName(m.name) === lower && normalizeName(m.name) !== exceptLower)) {
    throw new MacroStoreError(`Macro already exists: ${name}.`, "duplicate-name");
  }
}

function applyMutation(base: MacroFile, mutation: Mutation, at = nowIso()): MacroFile {
  const file = cloneFile(base);
  switch (mutation.type) {
    case "create": {
      assertValidName(mutation.input.name);
      if (!mutation.input.body) throw new MacroStoreError("Macro body cannot be empty.", "empty-body");
      ensureUnique(file, mutation.input.name);
      file.macros.push({ ...mutation.input, createdAt: at, updatedAt: at });
      break;
    }
    case "update": {
      const index = findIndex(file, mutation.name);
      if (index < 0) throw new MacroStoreError(`Macro not found: ${mutation.name}.`, "not-found");
      const current = file.macros[index]!;
      const nextName = mutation.patch.name ?? current.name;
      assertValidName(nextName);
      ensureUnique(file, nextName, current.name);
      const nextBody = mutation.patch.body ?? current.body;
      if (!nextBody) throw new MacroStoreError("Macro body cannot be empty.", "empty-body");
      file.macros[index] = { ...current, ...mutation.patch, name: nextName, body: nextBody, createdAt: current.createdAt, updatedAt: at };
      break;
    }
    case "delete": {
      const index = findIndex(file, mutation.name);
      if (index < 0) throw new MacroStoreError(`Macro not found: ${mutation.name}.`, "not-found");
      file.macros.splice(index, 1);
      break;
    }
    case "duplicate": {
      assertValidName(mutation.target);
      const source = requireMacro(file, mutation.source);
      ensureUnique(file, mutation.target);
      file.macros.push({ ...source, name: mutation.target, createdAt: at, updatedAt: at });
      break;
    }
  }
  validateMacroFile(file, "memory");
  return file;
}

function mutationConflicts(base: MacroFile, current: MacroFile, mutation: Mutation): boolean {
  const changed = (name: string) => macroHash(base.macros[findIndex(base, name)]) !== macroHash(current.macros[findIndex(current, name)]);
  switch (mutation.type) {
    case "create":
      return findIndex(current, mutation.input.name) >= 0;
    case "update":
      return changed(mutation.name) || (mutation.patch.name ? findIndex(current, mutation.patch.name) >= 0 && normalizeName(mutation.patch.name) !== normalizeName(mutation.name) : false);
    case "delete":
      return changed(mutation.name);
    case "duplicate":
      return changed(mutation.source) || findIndex(current, mutation.target) >= 0;
  }
}

export async function saveMacroFile(file: MacroFile, filePath = resolveMacroFilePath(), options: SaveMacroFileOptions = {}): Promise<void> {
  await guardedSaveMacroFile(filePath, file, options);
}

export class MacroStore {
  private snapshot?: Snapshot;
  constructor(private readonly filePath = resolveMacroFilePath()) {}

  async load(): Promise<MacroFile> {
    this.snapshot = await readSnapshot(this.filePath);
    return cloneFile(this.snapshot.file);
  }

  private async ensureLoaded(): Promise<Snapshot> {
    if (!this.snapshot) await this.load();
    return this.snapshot!;
  }

  async listMacros(): Promise<Macro[]> {
    const snapshot = await this.ensureLoaded();
    return cloneFile({ version: 1, macros: snapshot.file.macros }).macros.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  }

  async getMacro(name: string): Promise<Macro | undefined> {
    const snapshot = await this.ensureLoaded();
    const macro = snapshot.file.macros[findIndex(snapshot.file, name)];
    return macro ? (JSON.parse(JSON.stringify(macro)) as Macro) : undefined;
  }

  private async commit(mutation: Mutation): Promise<MacroFile> {
    const base = await this.ensureLoaded();
    await withWriteLock(this.filePath, async () => {
      const current = await readSnapshot(this.filePath);
      const changed = current.hash !== base.hash || current.mtimeMs !== base.mtimeMs;
      if (changed) {
        if (mutationConflicts(base.file, current.file, mutation)) throw new MacroStoreError("Macro file changed concurrently; refusing to overwrite conflicting changes.", "concurrent-conflict");
        const merged = applyMutation(current.file, mutation);
        await writeAtomic(this.filePath, merged);
      } else {
        const next = applyMutation(base.file, mutation);
        await writeAtomic(this.filePath, next);
      }
      this.snapshot = await readSnapshot(this.filePath);
    });
    return cloneFile(this.snapshot!.file);
  }

  async createMacro(input: CreateMacroInput): Promise<Macro> {
    const file = await this.commit({ type: "create", input });
    return requireMacro(file, input.name);
  }

  async updateMacro(name: string, patch: UpdateMacroPatch): Promise<Macro> {
    const file = await this.commit({ type: "update", name, patch });
    return requireMacro(file, patch.name ?? name);
  }

  async deleteMacro(name: string): Promise<void> {
    await this.commit({ type: "delete", name });
  }

  async duplicateMacro(source: string, target: string): Promise<Macro> {
    const file = await this.commit({ type: "duplicate", source, target });
    return requireMacro(file, target);
  }
}

const defaultStore = new MacroStore();
export const listMacros = () => defaultStore.listMacros();
export const getMacro = (name: string) => defaultStore.getMacro(name);
export const createMacro = (input: CreateMacroInput) => defaultStore.createMacro(input);
export const updateMacro = (name: string, patch: UpdateMacroPatch) => defaultStore.updateMacro(name, patch);
export const deleteMacro = (name: string) => defaultStore.deleteMacro(name);
export const duplicateMacro = (source: string, target: string) => defaultStore.duplicateMacro(source, target);
