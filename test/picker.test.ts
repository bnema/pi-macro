import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MacroStore } from "../src/macro-store.js";
import { MacroPickerState, openMacroPicker } from "../src/picker.js";
import type { CommandContext } from "../src/commands.js";

const tempDirs: string[] = [];
async function store(): Promise<MacroStore> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-macro-picker-"));
  tempDirs.push(dir);
  return new MacroStore(path.join(dir, "macros.json"));
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("MacroPickerState", () => {
  it("filters visible rows and clamps selection after query changes", () => {
    const state = new MacroPickerState();
    state.setMacros([
      { name: "review", body: "Review", createdAt: "a", updatedAt: "a" },
      { name: "plan", description: "spec", body: "Plan", createdAt: "a", updatedAt: "a" },
    ]);
    state.move(10);
    expect(state.selectedIndex).toBe(1);

    state.setQuery("rev");

    expect(state.visibleMacros.map((m) => m.name)).toEqual(["review"]);
    expect(state.selectedIndex).toBe(0);
  });

  it("previews static variables and interactive placeholders", async () => {
    const state = new MacroPickerState();
    state.setMacros([{ name: "ask", body: "Project {{project}} / {{ask:Need?}}", createdAt: "a", updatedAt: "a" }]);

    await state.refreshPreview({ cwd: "/tmp/example" }, "");

    expect(state.snapshot("").preview?.text).toContain("Project example");
    expect(state.snapshot("").preview?.text).toContain("[interactive: ask:Need?]");
  });
});

describe("openMacroPicker", () => {
  type TestComponent = { handleInput(data: string): void; render(width: number): string[] };
  type TestTheme = { fg?: (color: string, text: string) => string; bg?: (color: string, text: string) => string };
  type TestFactory = (tui: { requestRender: () => void }, theme: TestTheme, keybindings: Record<string, never>, done: () => void) => TestComponent;

  function ctx(ui: Record<string, unknown>): CommandContext {
    return { mode: "tui", hasUI: true, cwd: process.cwd(), isIdle: () => true, ui: ui as CommandContext["ui"] };
  }

  it("fails clearly outside TUI", async () => {
    await expect(openMacroPicker({ mode: "print", hasUI: false }, { store: await store(), sendUserMessage: vi.fn() })).rejects.toThrow("only available in Pi TUI mode");
  });

  it("uses pi-fzf-style percentage overlay sizing", async () => {
    const ui = { custom: vi.fn(async (_factory: TestFactory, _options: unknown) => undefined) };

    await openMacroPicker(ctx(ui), { store: await store(), sendUserMessage: vi.fn() });

    expect(ui.custom).toHaveBeenCalledWith(expect.any(Function), {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" },
    });
  });

  it("renders a full-width frame with consistently styled outer borders", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body" });
    let component: TestComponent | undefined;
    const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });

    const lines = component!.render(140);
    const ansi = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
    const plain = (text: string) => text.replace(ansi, "");
    const bottom = lines[lines.length - 1]!;

    expect(plain(lines[0]!).length).toBe(140);
    expect(plain(bottom).length).toBe(140);
    expect(lines[0]).toMatch(/^\x1b\[90m╭─ \x1b\[0m/);
    expect(lines[0]).toMatch(/\x1b\[90m ─+╮\x1b\[0m$/);
    expect(bottom).toMatch(/^\x1b\[90m╰─+╯\x1b\[0m$/);
  });

  it("form render shows muted labels and a visible active-field cursor", async () => {
    const s = await store();
    let component: TestComponent | undefined;
    const theme = { fg: (color: string, text: string) => `[${color}:${text}]` };
    const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, theme, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() }, { query: "newmacro" });

    component!.handleInput("n");
    const rendered = component!.render(100).join("\n");

    expect(rendered).toContain("[muted:name:]");
    expect(rendered).toContain("[muted:description:]");
    expect(rendered).toContain("[muted:body:]");
    expect(rendered).toContain("[accent:▌ ]");
  });

  it("inline create from empty query does not use Pi dialogs", async () => {
    const s = await store();
    let component: TestComponent | undefined;
    const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }), input: vi.fn(), editor: vi.fn(), confirm: vi.fn() };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() }, { query: "newmacro" });

    component!.handleInput("n");
    component!.handleInput("\t");
    for (const ch of "desc") component!.handleInput(ch);
    component!.handleInput("\t");
    for (const ch of "Body") component!.handleInput(ch);
    component!.handleInput("\r");

    await vi.waitFor(async () => expect(await s.getMacro("newmacro")).toBeDefined());
    expect(ui.input).not.toHaveBeenCalled(); expect(ui.editor).not.toHaveBeenCalled(); expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("edit prefill/save and cancel do not use Pi dialogs", async () => {
    const s = await store(); await s.createMacro({ name: "review", description: "old", body: "Body" });
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }), input: vi.fn(), editor: vi.fn(), confirm: vi.fn() };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    component!.handleInput("e");
    expect(component!.render(80).join("\n")).toContain("review");
    component!.handleInput("\u001b");
    expect((await s.getMacro("review"))?.description).toBe("old");
    component!.handleInput("e"); component!.handleInput("\u0015"); for (const ch of "review2") component!.handleInput(ch); component!.handleInput("\t"); component!.handleInput("\u0015"); for (const ch of "new") component!.handleInput(ch); component!.handleInput("\u0013");
    await vi.waitFor(async () => expect(await s.getMacro("review2")).toBeDefined());
    expect(ui.input).not.toHaveBeenCalled(); expect(ui.editor).not.toHaveBeenCalled(); expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("duplicate prefill/save does not use Pi dialogs", async () => {
    const s = await store(); await s.createMacro({ name: "review", description: "desc", body: "Body" });
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }), input: vi.fn(), editor: vi.fn(), confirm: vi.fn() };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    component!.handleInput("y"); component!.handleInput("\u0013");
    await vi.waitFor(async () => expect(await s.getMacro("review-copy")).toBeDefined());
    expect(ui.input).not.toHaveBeenCalled(); expect(ui.editor).not.toHaveBeenCalled(); expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("delete inline confirm and cancel", async () => {
    const s = await store(); await s.createMacro({ name: "review", body: "Body" });
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }), confirm: vi.fn() };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    component!.handleInput("d"); expect(component!.render(80).join("\n")).toContain("Delete macro 'review'?"); component!.handleInput("n"); expect(await s.getMacro("review")).toBeDefined();
    component!.handleInput("d"); component!.handleInput("y"); await vi.waitFor(async () => expect(await s.getMacro("review")).toBeUndefined());
    expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("preview inline and validation errors", async () => {
    const s = await store(); await s.createMacro({ name: "review", body: "Hello {{project}}" });
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }), input: vi.fn(), editor: vi.fn(), confirm: vi.fn() };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    component!.handleInput("p"); await vi.waitFor(() => expect(component!.render(80).join("\n")).toContain("Preview: review")); component!.handleInput("\u001b");
    component!.handleInput("n"); component!.handleInput("\u0013"); expect(component!.render(80).join("\n")).toContain("Name is required"); for (const ch of "bad name") component!.handleInput(ch); component!.handleInput("\u0013"); expect(component!.render(80).join("\n")).toContain("Invalid macro name");
    expect(ui.input).not.toHaveBeenCalled(); expect(ui.editor).not.toHaveBeenCalled(); expect(ui.confirm).not.toHaveBeenCalled();
  });

  it("requests render for inline form open, typing, validation, save, and cancel", async () => {
    const s = await store();
    let component: TestComponent | undefined;
    const requestRender = vi.fn();
    const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() }, { query: "newmacro" });
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    requestRender.mockClear();

    component!.handleInput("n");
    expect(requestRender).toHaveBeenCalledTimes(1);
    component!.handleInput("\t");
    component!.handleInput("d");
    expect(requestRender).toHaveBeenCalledTimes(3);
    component!.handleInput("\u001b");
    expect(requestRender).toHaveBeenCalledTimes(4);

    component!.handleInput("n");
    requestRender.mockClear();
    component!.handleInput("\u0013");
    await vi.waitFor(() => expect(component!.render(80).join("\n")).toContain("Body is required"));
    expect(requestRender).toHaveBeenCalledTimes(1);

    component!.handleInput("\t"); component!.handleInput("\t");
    for (const ch of "Body") component!.handleInput(ch);
    requestRender.mockClear();
    component!.handleInput("\u0013");
    await vi.waitFor(async () => expect(await s.getMacro("newmacro")).toBeDefined());
    expect(requestRender).toHaveBeenCalled();
  });

  it("shows no-selection errors inline and requests render", async () => {
    const s = await store();
    let component: TestComponent | undefined;
    const requestRender = vi.fn();
    const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    await vi.waitFor(() => expect(requestRender).toHaveBeenCalled());
    requestRender.mockClear();

    for (const key of ["e", "d", "y"]) {
      expect(() => component!.handleInput(key)).not.toThrow();
      expect(component!.render(80).join("\n")).toContain("No macro selected.");
      expect(requestRender).toHaveBeenCalled();
      requestRender.mockClear();
    }
  });

  it("saves edited duplicates with a single create path", async () => {
    const s = await store(); await s.createMacro({ name: "review", description: "old", body: "Old body" });
    const create = vi.spyOn(s, "createMacro"); const duplicate = vi.spyOn(s, "duplicateMacro"); const update = vi.spyOn(s, "updateMacro");
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });

    component!.handleInput("y"); component!.handleInput("\t"); component!.handleInput("\u0015"); for (const ch of "new desc") component!.handleInput(ch); component!.handleInput("\t"); component!.handleInput("\u0015"); for (const ch of "New body") component!.handleInput(ch); component!.handleInput("\u0013");

    await vi.waitFor(async () => expect(await s.getMacro("review-copy")).toMatchObject({ description: "new desc", body: "New body" }));
    expect(create).toHaveBeenCalledWith({ name: "review-copy", description: "new desc", body: "New body" });
    expect(duplicate).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled();
  });

  it("ignores repeated Ctrl-S while create is pending", async () => {
    const s = await store();
    const originalCreate = s.createMacro.bind(s);
    const create = vi.spyOn(s, "createMacro").mockImplementation(async (input) => { await new Promise((resolve) => setTimeout(resolve, 20)); return originalCreate(input); });
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() }, { query: "fast" });

    component!.handleInput("n"); component!.handleInput("\t"); component!.handleInput("\t"); for (const ch of "Body") component!.handleInput(ch); component!.handleInput("\u0013"); component!.handleInput("\u0013");

    await vi.waitFor(async () => expect(await s.getMacro("fast")).toBeDefined());
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("ignores repeated delete confirmation while delete is pending", async () => {
    const s = await store(); await s.createMacro({ name: "review", body: "Body" });
    const originalDelete = s.deleteMacro.bind(s);
    const del = vi.spyOn(s, "deleteMacro").mockImplementation(async (name) => { await new Promise((resolve) => setTimeout(resolve, 20)); return originalDelete(name); });
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });

    component!.handleInput("d"); component!.handleInput("y"); component!.handleInput("y");

    await vi.waitFor(async () => expect(await s.getMacro("review")).toBeUndefined());
    expect(del).toHaveBeenCalledTimes(1);
  });

  it("Enter sends selected macro through handleMacro and honors confirmation", async () => {
    const s = await store(); await s.createMacro({ name: "review", body: "{{confirm:sure?}}Body {{input}}" });
    let component: TestComponent | undefined; const done = vi.fn(); const sendUserMessage = vi.fn();
    const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, done); }), confirm: vi.fn(async () => true) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage }, { input: "now" });

    component!.handleInput("\r");

    await vi.waitFor(() => expect(sendUserMessage).toHaveBeenCalledWith("yesBody now", undefined));
    expect(ui.confirm).toHaveBeenCalled(); expect(done).toHaveBeenCalled();
  });

  it("supports middle insertion and multiline inline body editing", async () => {
    const s = await store();
    let component: TestComponent | undefined; const ui = { custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }) };
    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() }, { query: "compose" });

    component!.handleInput("n"); component!.handleInput("\t"); component!.handleInput("\t"); component!.handleInput("A"); component!.handleInput("\u001b[D"); component!.handleInput("B"); component!.handleInput("\u001b[F"); component!.handleInput("\u000f"); component!.handleInput("C"); component!.handleInput("\r");

    await vi.waitFor(async () => expect(await s.getMacro("compose")).toMatchObject({ body: "BA\nC" }));
  });
});
