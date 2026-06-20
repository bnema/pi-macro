import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacroStore } from "../src/macro-store.js";
import { handleMacro, parseMacroArgs, parseMacroSubcommand, type CommandContext } from "../src/commands.js";

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

  it("recognizes reserved /macro subcommands", () => {
    expect(parseMacroSubcommand("list crit")).toEqual({ subcommand: "list", rest: "crit" });
    expect(parseMacroSubcommand("review this")).toEqual({ rest: "review this" });
  });

  it("uses send to run a macro whose name is a reserved subcommand", async () => {
    const s = await store();
    await s.createMacro({ name: "list", tag: "", body: "List macro: {{input}}" });
    const send = vi.fn();

    await handleMacro("send list details", ctx(), { store: s, sendUserMessage: send });

    expect(send).toHaveBeenCalledWith("List macro: details", undefined);
  });
});

describe("/macro", () => {
  it("sends a known macro as a plain expanded body", async () => {
    const s = await store();
    await s.createMacro({ name: "review", tag: "", body: "Review: {{input}}" });
    const send = vi.fn();

    await handleMacro("review this code", ctx(), { store: s, sendUserMessage: send });

    expect(send).toHaveBeenCalledWith("Review: this code", undefined);
  });

  it("preserves quotes in input binding", async () => {
    const s = await store();
    await s.createMacro({ name: "challenge", tag: "", body: "Challenge {{args}}" });
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
    await s.createMacro({ name: "review", tag: "", body: "Review" });
    const send = vi.fn();

    await handleMacro("review", ctx({ isIdle: () => false }), { store: s, sendUserMessage: send });

    expect(send).toHaveBeenCalledWith("Review", { deliverAs: "followUp" });
  });

  it("confirms interactive macros with the final resolved message", async () => {
    const s = await store();
    await s.createMacro({ name: "ask", tag: "", body: "Answer: {{ask:Question?}}" });
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
    await handleMacro("find rev", ctx(), { store: await store(), sendUserMessage: vi.fn(), openPicker });
    expect(openPicker).toHaveBeenNthCalledWith(1, expect.anything());
    expect(openPicker).toHaveBeenNthCalledWith(2, expect.anything(), { query: "rev" });
  });
});

describe("management commands", () => {
  it("lists with tags and filters by tag without opening picker", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Review critique", tag: "quality" });
    await s.createMacro({ name: "plan", body: "Plan", tag: "planning" });
    const c = ctx();
    const openPicker = vi.fn();

    await handleMacro("list tag:quality", c, { store: s, sendUserMessage: vi.fn(), openPicker });

    expect(c.ui?.notify).toHaveBeenCalledWith("review [quality]", "info");
    expect(openPicker).not.toHaveBeenCalled();
  });

  it("keeps list output available without UI even when Pi provides a no-op ui object", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Review", tag: "quality" });
    const c = ctx({ hasUI: false, mode: "json", ui: { notify: vi.fn() } });

    await handleMacro("list", c, { store: s, sendUserMessage: vi.fn() });

    expect(c.ui?.notify).not.toHaveBeenCalled();
    expect(JSON.parse((c as CommandContext & { output?: string }).output ?? "[]")).toMatchObject([{ name: "review", tag: "quality" }]);
  });

  it("creates a macro with UI-provided body and tag values", async () => {
    const s = await store();
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce("quality");
    vi.mocked(c.ui!.editor!).mockResolvedValueOnce("Body");

    await handleMacro("new review", c, { store: s, sendUserMessage: vi.fn() });

    expect(c.ui?.input).toHaveBeenCalledOnce();
    expect(c.ui?.input).toHaveBeenCalledWith("Macro tag", "");
    expect(await s.getMacro("review")).toEqual(expect.objectContaining({ name: "review", tag: "quality", body: "Body" }));
    expect(await s.getMacro("review")).not.toHaveProperty("description");
  });

  it("defaults tag to empty when tag input is unavailable during create", async () => {
    const s = await store();
    const editor = vi.fn(async () => "Body");
    const c = ctx({ ui: { editor, notify: vi.fn() } });

    await handleMacro("new review", c, { store: s, sendUserMessage: vi.fn() });

    expect(editor).toHaveBeenCalledWith("Macro body", "");
    expect(await s.getMacro("review")).toEqual(expect.objectContaining({ name: "review", tag: "", body: "Body" }));
  });

  it("cancels create when tag input is cancelled before opening the editor", async () => {
    const s = await store();
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce(undefined);

    await expect(handleMacro("new review", c, { store: s, sendUserMessage: vi.fn() })).rejects.toThrow("Cancelled.");

    expect(c.ui?.editor).not.toHaveBeenCalled();
    expect(await s.getMacro("review")).toBeUndefined();
  });

  it("edits a macro including its tag", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Old", tag: "quality" });
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce("review2").mockResolvedValueOnce("planning");
    vi.mocked(c.ui!.editor!).mockResolvedValueOnce("New");

    await handleMacro("edit review", c, { store: s, sendUserMessage: vi.fn() });

    expect(c.ui?.input).toHaveBeenCalledTimes(2);
    expect(c.ui?.input).toHaveBeenNthCalledWith(1, "Macro name", "review");
    expect(c.ui?.input).toHaveBeenNthCalledWith(2, "Macro tag", "quality");
    expect(await s.getMacro("review2")).toEqual(expect.objectContaining({ name: "review2", tag: "planning", body: "New" }));
    expect(await s.getMacro("review2")).not.toHaveProperty("description");
  });

  it("cancels edit when tag input is cancelled without mutating the macro", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Old", tag: "quality" });
    const c = ctx();
    vi.mocked(c.ui!.input!).mockResolvedValueOnce("review2").mockResolvedValueOnce(undefined);

    await expect(handleMacro("edit review", c, { store: s, sendUserMessage: vi.fn() })).rejects.toThrow("Cancelled.");

    expect(c.ui?.editor).not.toHaveBeenCalled();
    expect(await s.getMacro("review")).toEqual(expect.objectContaining({ name: "review", tag: "quality", body: "Old" }));
    expect(await s.getMacro("review2")).toBeUndefined();
  });

  it("deletes and shows a macro", async () => {
    const s = await store();
    await s.createMacro({ name: "review", tag: "", body: "Body" });
    const c = ctx();
    await handleMacro("show review", c, { store: s, sendUserMessage: vi.fn() });
    expect(c.ui?.notify).toHaveBeenCalledWith(expect.stringContaining("Preview:"), "info");

    await handleMacro("delete review", c, { store: s, sendUserMessage: vi.fn() });
    expect(await s.getMacro("review")).toBeUndefined();
  });

  it("keeps show output available without UI", async () => {
    const s = await store();
    await s.createMacro({ name: "review", tag: "", body: "Body" });
    const c = ctx({ hasUI: false, mode: "print", ui: { notify: vi.fn() } });

    await handleMacro("show review", c, { store: s, sendUserMessage: vi.fn() });

    expect(c.ui?.notify).not.toHaveBeenCalled();
    expect((c as CommandContext & { output?: string }).output).toContain("Preview:");
    expect((c as CommandContext & { output?: string }).output).toContain("Body");
  });

  it("refuses delete without interactive confirmation", async () => {
    const s = await store();
    await s.createMacro({ name: "review", tag: "", body: "Body" });

    await expect(handleMacro("delete review", ctx({ hasUI: false, mode: "print", ui: undefined }), { store: s, sendUserMessage: vi.fn() })).rejects.toThrow("requires interactive confirmation");
    expect(await s.getMacro("review")).toBeDefined();
  });

  it("duplicates a macro with its tag", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body", tag: "quality" });

    await handleMacro("duplicate review copy", ctx(), { store: s, sendUserMessage: vi.fn() });

    expect(await s.getMacro("copy")).toMatchObject({ name: "copy", body: "Body", tag: "quality" });
  });
});
