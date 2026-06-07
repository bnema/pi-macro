import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerPiMacro from "../extensions/index.js";
import { MacroStore } from "../src/macro-store.js";
import type { CommandContext } from "../src/commands.js";

const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function seededStore(): Promise<{ store: MacroStore; file: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-macro-extension-"));
  tempDirs.push(dir);
  const file = path.join(dir, "macros.json");
  const store = new MacroStore(file);
  await store.createMacro({ name: "review", body: "Review {{input}}" });
  return { store, file };
}

describe("extension entrypoint", () => {
  it("registers all macro commands and forwards plain sends through pi.sendUserMessage", async () => {
    const { file } = await seededStore();
    const previous = process.env.PI_MACRO_FILE;
    process.env.PI_MACRO_FILE = file;
    try {
      const handlers = new Map<string, (args: string, ctx: CommandContext) => Promise<void> | void>();
      const sendUserMessage = vi.fn();
      registerPiMacro({
        sendUserMessage,
        registerCommand: (name: string, options: { handler: (args: string, ctx: CommandContext) => Promise<void> | void }) => {
          handlers.set(name, options.handler);
        },
      } as never);

      expect([...handlers.keys()].sort()).toEqual(["macro", "macro-delete", "macro-duplicate", "macro-edit", "macro-find", "macro-list", "macro-new", "macro-show"].sort());
      await handlers.get("macro")!("review this", { mode: "tui", hasUI: true, cwd: process.cwd(), isIdle: () => true, ui: { notify: vi.fn(), confirm: vi.fn(async () => true) } });

      expect(sendUserMessage).toHaveBeenCalledWith("Review this", undefined);
    } finally {
      if (previous === undefined) delete process.env.PI_MACRO_FILE;
      else process.env.PI_MACRO_FILE = previous;
    }
  });
});
