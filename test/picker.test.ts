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
  type TestComponent = { handleInput(data: string): void };
  type TestFactory = (tui: { requestRender: () => void }, theme: Record<string, never>, keybindings: Record<string, never>, done: () => void) => TestComponent;

  function ctx(ui: Record<string, unknown>): CommandContext {
    return { mode: "tui", hasUI: true, cwd: process.cwd(), isIdle: () => true, ui: ui as CommandContext["ui"] };
  }

  it("fails clearly outside TUI", async () => {
    await expect(openMacroPicker({ mode: "print", hasUI: false }, { store: await store(), sendUserMessage: vi.fn() })).rejects.toThrow("only available in Pi TUI mode");
  });

  it("empty result create uses query as default name", async () => {
    const s = await store();
    let component: TestComponent | undefined;
    const ui = {
      custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }),
      input: vi.fn(async () => "desc"),
      editor: vi.fn(async () => "Body"),
      confirm: vi.fn(),
    };

    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() }, { query: "newmacro" });
    component!.handleInput("n");
    await vi.waitFor(async () => expect(await s.getMacro("newmacro")).toBeDefined());
    expect(ui.input).toHaveBeenCalledWith("Description (optional)");
  });

  it("delete requires confirmation", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body" });
    let component: TestComponent | undefined;
    const ui = {
      custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }),
      confirm: vi.fn(async () => false),
    };

    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    component!.handleInput("d");

    await vi.waitFor(() => expect(ui.confirm).toHaveBeenCalledWith("Delete macro", "Delete macro 'review'?"));
    expect(await s.getMacro("review")).toBeDefined();
  });

  it("duplicate prompts for target name", async () => {
    const s = await store();
    await s.createMacro({ name: "review", body: "Body" });
    let component: TestComponent | undefined;
    const ui = {
      custom: vi.fn(async (factory: TestFactory) => { component = factory({ requestRender: vi.fn() }, {}, {}, vi.fn()); }),
      input: vi.fn(async () => "review-copy"),
    };

    await openMacroPicker(ctx(ui), { store: s, sendUserMessage: vi.fn() });
    component!.handleInput("y");

    await vi.waitFor(async () => expect(await s.getMacro("review-copy")).toBeDefined());
    expect(ui.input).toHaveBeenCalledWith("New macro name", "review-copy");
  });
});
