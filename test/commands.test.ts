import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacroStore } from "../src/macro-store.js";
import { handleMacro, handleMacroDelete, handleMacroDuplicate, handleMacroEdit, handleMacroFind, handleMacroList, handleMacroNew, handleMacroShow, parseMacroArgs, type CommandContext } from "../src/commands.js";

const tempDirs: string[] = [];
async function store(): Promise<MacroStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-macro-commands-"));
  tempDirs.push(dir);
  return new MacroStore(path.join(dir, "macros.json"));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function ctx(overrides: Partial<CommandContext> = {}): CommandContext {
  return { mode: "tui", hasUI: true, cwd: process.cwd(), isIdle: () => true, ui: { notify: vi.fn(), confirm: vi.fn(async () => true), input: vi.fn(), editor: vi.fn(), select: vi.fn() }, ...overrides };
}

describe("command parser", () => {
  it("uses first whitespace token as name and preserves raw remaining input", () => {
    expect(parseMacroArgs("challenge hello world")).toEqual({ name: "challenge", input: "hello world" });
    expect(parseMacroArgs("challenge \"hello world\"")).toEqual({ name: "challenge", input: "\"hello world\"" });
  });
});

describe("/macro", () => {
  it("sends a known macro as a plain expanded body", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Review: {{input}}" });
    const send = vi.fn();

    await handleMacro("review this code", ctx(), { store: s, sendUserMessage: send });

    expect(send).toHaveBeenCalledWith("Review: this code", undefined);
  });

  it("preserves quotes in input binding", async () => {
    const s = await store();
    await s.createMacro({ name: "challenge", body: "Challenge {{args}}" });
    const send = vi.fn();

    await handleMacro("challenge \"hello world\"", ctx(), { store: s, sendUserMessage: send });

    expect(send).toHaveBeenCalledWith("Challenge \"hello world\"", undefined);
  });

  it("fails clearly for a missing macro without UI", async () => {
    const s = await store();
    await expect(handleMacro("missing", ctx({ hasUI: false, mode: "print", ui: undefined }), { store: s, sendUserMessage: vi.fn() })).rejects.toThrow("Macro not found: missing");
  });

  it("uses followUp delivery while streaming", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Review" });
    const send = vi.fn();

    await handleMacro("review", ctx({ isIdle: () => false }), { store: s, sendUserMessage: send });

    expect(send).toHaveBeenCalledWith("Review", { deliverAs: "followUp" });
  });

  it("confirms interactive macros with the final resolved message", async () => {
    const s = await store();
    await s.createMacro({ name: "ask", body: "Answer: {{ask:Question?}}" });
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce("resolved value");
    const send = vi.fn();

    await handleMacro("ask", c, { store: s, sendUserMessage: send });

    expect(c.ui?.confirm).toHaveBeenCalledWith("Confirm", expect.stringContaining("Answer: resolved value"));
    expect(send).toHaveBeenCalledWith("Answer: resolved value", undefined);
  });

  it("opens picker for no args and find uses filtered picker", async () => {
    const openPicker = vi.fn();
    await handleMacro("", ctx(), { store: await store(), sendUserMessage: vi.fn(), openPicker });
    await handleMacroFind("rev", ctx(), { store: await store(), sendUserMessage: vi.fn(), openPicker });
    expect(openPicker).toHaveBeenNthCalledWith(1, expect.anything());
    expect(openPicker).toHaveBeenNthCalledWith(2, expect.anything(), { query: "rev" });
  });
});

describe("management commands", () => {
  it("lists and filters without opening picker", async () => {
    const s = await store();
    await s.createMacro({ name: "review", description: "critique", body: "Review" });
    await s.createMacro({ name: "plan", body: "Plan" });
    const c = ctx();
    const openPicker = vi.fn();

    await handleMacroList("crit", c, { store: s, sendUserMessage: vi.fn(), openPicker });

    expect(c.ui?.notify).toHaveBeenCalledWith("review — critique", "info");
    expect(openPicker).not.toHaveBeenCalled();
  });

  it("keeps list output available without UI even when Pi provides a no-op ui object", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Review" });
    const c = ctx({ hasUI: false, mode: "json", ui: { notify: vi.fn() } });

    await handleMacroList("", c, { store: s, sendUserMessage: vi.fn() });

    expect(c.ui?.notify).not.toHaveBeenCalled();
    expect(JSON.parse((c as CommandContext & { output?: string }).output ?? "[]")).toMatchObject([{ name: "review" }]);
  });

  it("creates a macro with UI-provided values", async () => {
    const s = await store();
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce("desc");
    vi.mocked(c.ui!.editor!).mockResolvedValueOnce("Body");

    await handleMacroNew("review", c, { store: s, sendUserMessage: vi.fn() });

    expect(await s.getMacro("review")).toMatchObject({ name: "review", description: "desc", body: "Body" });
  });

  it("edits a macro", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Old" });
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce("review2").mockResolvedValueOnce("desc");
    vi.mocked(c.ui!.editor!).mockResolvedValueOnce("New");

    await handleMacroEdit("review", c, { store: s, sendUserMessage: vi.fn() });

    expect(await s.getMacro("review2")).toMatchObject({ name: "review2", description: "desc", body: "New" });
  });

  it("deletes and shows a macro", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body" });
    const c = ctx();
    await handleMacroShow("review", c, { store: s, sendUserMessage: vi.fn() });
    expect(c.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("Preview:"), "info");

    await handleMacroDelete("review", c, { store: s, sendUserMessage: vi.fn() });
    expect(await s.getMacro("review")).toBeUndefined();
  });

  it("keeps show output available without UI", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body" });
    const c = ctx({ hasUI: false, mode: "print", ui: { notify: vi.fn() } });

    await handleMacroShow("review", c, { store: s, sendUserMessage: vi.fn() });

    expect(c.ui?.notify).not.toHaveBeenCalled();
    expect((c as CommandContext & { output?: string }).output).toContain("Preview:");
    expect((c as CommandContext & { output?: string }).output).toContain("Body");
  });

  it("refuses delete without interactive confirmation", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body" });

    await expect(handleMacroDelete("review", ctx({ hasUI: false, mode: "print", ui: undefined }), { store: s, sendUserMessage: vi.fn() })).rejects.toThrow("requires interactive confirmation");
    expect(await s.getMacro("review")).toBeDefined();
  });

  it("duplicates a macro", async () => {
    const s = await store();
    await s.createMacro({ name: "review", description: "desc", body: "Body" });

    await handleMacroDuplicate("review copy", ctx(), { store: s, sendUserMessage: vi.fn() });

    expect(await s.getMacro("copy")).toMatchObject({ name: "copy", description: "desc", body: "Body" });
  });
});
