import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isValidMacroName, loadMacroFile, MacroStore, resolveMacroFilePath, saveMacroFile } from "../src/macro-store.js";

const tempDirs: string[] = [];

async function tempFile(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-macro-test-"));
  tempDirs.push(dir);
  return path.join(dir, "macros.json");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("macro path resolution", () => {
  it("uses PI_MACRO_FILE override", () => {
    expect(resolveMacroFilePath({ PI_MACRO_FILE: "/tmp/custom-macros.json" })).toBe("/tmp/custom-macros.json");
  });
});

describe("macro name validation", () => {
  it("accepts valid names", () => {
    for (const name of ["review", "spec-plan", "review_2", "A", "a".repeat(64)]) {
      expect(isValidMacroName(name), name).toBe(true);
    }
  });

  it("rejects invalid names", () => {
    for (const name of ["", "has space", "a/b", "-leading", "_leading", "a".repeat(65)]) {
      expect(isValidMacroName(name), name).toBe(false);
    }
  });
});

describe("MacroStore", () => {
  it("missing file creates empty store", async () => {
    const file = await tempFile();
    expect(await loadMacroFile(file)).toEqual({ version: 1, macros: [] });
    const store = new MacroStore(file);
    expect(await store.listMacros()).toEqual([]);
    await store.createMacro({ name: "review", body: "Review this" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 1, macros: [{ name: "review" }] });
  });

  it("malformed JSON returns clear error and does not overwrite", async () => {
    const file = await tempFile();
    await writeFile(file, "{ nope", "utf8");
    const store = new MacroStore(file);
    await expect(store.load()).rejects.toMatchObject({ code: "malformed-json" });
    expect(await readFile(file, "utf8")).toBe("{ nope");
  });

  it("rejects duplicate names case-insensitively", async () => {
    const store = new MacroStore(await tempFile());
    await store.createMacro({ name: "Review", body: "one" });
    await expect(store.createMacro({ name: "review", body: "two" })).rejects.toMatchObject({ code: "duplicate-name" });
  });

  it("sorts list case-insensitively while preserving display case", async () => {
    const store = new MacroStore(await tempFile());
    await store.createMacro({ name: "beta", body: "b" });
    await store.createMacro({ name: "Alpha", body: "a" });
    expect((await store.listMacros()).map((m) => m.name)).toEqual(["Alpha", "beta"]);
    expect((await store.getMacro("alpha"))?.name).toBe("Alpha");
  });

  it("update preserves createdAt, updates updatedAt, and preserves unknown fields", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 1, macros: [{ name: "review", body: "old", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", note: "keep" }] }), "utf8");
    const store = new MacroStore(file);
    await store.load();
    const updated = await store.updateMacro("REVIEW", { body: "new" });
    expect(updated.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(updated.updatedAt).not.toBe(updated.createdAt);
    expect(updated.note).toBe("keep");
    expect(updated.body).toBe("new");
  });

  it("delete removes only requested macro", async () => {
    const store = new MacroStore(await tempFile());
    await store.createMacro({ name: "one", body: "1" });
    await store.createMacro({ name: "two", body: "2" });
    await store.deleteMacro("ONE");
    expect((await store.listMacros()).map((m) => m.name)).toEqual(["two"]);
  });

  it("duplicate copies body with new timestamps", async () => {
    const store = new MacroStore(await tempFile());
    const source = await store.createMacro({ name: "source", body: "body" });
    const copy = await store.duplicateMacro("SOURCE", "copy");
    expect(copy).toMatchObject({ name: "copy", body: "body" });
    expect(copy.createdAt).not.toBe(source.createdAt);
    expect(copy.updatedAt).not.toBe(source.updatedAt);
  });

  it("migrates old description fields out of loaded macros", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 1, macros: [{ name: "review", description: "old", body: "body", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] }), "utf8");
    const store = new MacroStore(file);
    expect(await store.getMacro("review")).toEqual({ name: "review", body: "body", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });
    await store.updateMacro("review", { body: "new" });
    expect(await readFile(file, "utf8")).not.toContain("description");
  });

  it("saveMacroFile strips legacy description fields before writing", async () => {
    const file = await tempFile();
    await saveMacroFile({ version: 1, macros: [{ name: "review", description: "old", body: "body", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] } as never, file);
    expect(await readFile(file, "utf8")).not.toContain("description");
    expect(await loadMacroFile(file)).toEqual({ version: 1, macros: [{ name: "review", body: "body", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }] });
  });

  it("detects concurrent save conflict", async () => {
    const file = await tempFile();
    const a = new MacroStore(file);
    await a.createMacro({ name: "same", body: "one" });
    const b = new MacroStore(file);
    await b.load();
    await a.updateMacro("same", { body: "two" });
    await expect(b.updateMacro("same", { body: "three" })).rejects.toMatchObject({ code: "concurrent-conflict" });
  });

  it("does not lose updates when two store instances modify different macros", async () => {
    const file = await tempFile();
    const seed = new MacroStore(file);
    await seed.createMacro({ name: "one", body: "1" });
    await seed.createMacro({ name: "two", body: "2" });
    const a = new MacroStore(file);
    const b = new MacroStore(file);
    await a.load();
    await b.load();
    await a.updateMacro("one", { body: "1a" });
    await b.updateMacro("two", { body: "2b" });
    const final = new MacroStore(file);
    expect(await final.getMacro("one")).toMatchObject({ body: "1a" });
    expect(await final.getMacro("two")).toMatchObject({ body: "2b" });
  });

  it("does not lose overlapping concurrent creates from two loaded store instances", async () => {
    const file = await tempFile();
    const a = new MacroStore(file);
    const b = new MacroStore(file);
    await a.load();
    await b.load();
    await Promise.all([
      a.createMacro({ name: "one", body: "1" }),
      b.createMacro({ name: "two", body: "2" }),
    ]);
    const names = (await new MacroStore(file).listMacros()).map((m) => m.name);
    expect(names).toEqual(["one", "two"]);
  });

  it("saveMacroFile refuses to bypass malformed store safeguards", async () => {
    const file = await tempFile();
    await writeFile(file, "{ nope", "utf8");
    await expect(saveMacroFile({ version: 1, macros: [] }, file)).rejects.toMatchObject({ code: "malformed-json" });
    expect(await readFile(file, "utf8")).toBe("{ nope");
  });

  it("saveMacroFile refuses to overwrite an existing different store without an expected snapshot", async () => {
    const file = await tempFile();
    const store = new MacroStore(file);
    await store.createMacro({ name: "existing", body: "keep" });
    await expect(saveMacroFile({ version: 1, macros: [] }, file)).rejects.toMatchObject({ code: "concurrent-conflict" });
    expect((await new MacroStore(file).listMacros()).map((macro) => macro.name)).toEqual(["existing"]);
  });

  it("saveMacroFile uses the same lock path as store commits", async () => {
    const file = await tempFile();
    const lockFile = `${file}.lock`;
    await writeFile(lockFile, `${process.pid}\n`, "utf8");
    const start = Date.now();
    const save = saveMacroFile({ version: 1, macros: [] }, file);
    await new Promise((resolve) => setTimeout(resolve, 30));
    await rm(lockFile, { force: true });
    await save;
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
    expect(await loadMacroFile(file)).toEqual({ version: 1, macros: [] });
  });

  it("recovers stale lock files", async () => {
    const file = await tempFile();
    const lockFile = `${file}.lock`;
    await writeFile(lockFile, "99999999\n", "utf8");
    const stale = new Date(Date.now() - 60_000);
    await utimes(lockFile, stale, stale);

    await saveMacroFile({ version: 1, macros: [] }, file);

    expect(await loadMacroFile(file)).toEqual({ version: 1, macros: [] });
  });

  it("treats unknown top-level versions as read-only errors", async () => {
    const file = await tempFile();
    await writeFile(file, JSON.stringify({ version: 2, macros: [] }), "utf8");
    await expect(new MacroStore(file).load()).rejects.toMatchObject({ code: "read-only-version" });
  });
});
