import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCommandHandlers, type CommandContext } from "../src/commands.js";
import { openMacroPicker } from "../src/picker.js";

const DESCRIPTIONS: Record<string, string> = {
  macro: "Open macro picker or send a named macro.",
  "macro-list": "List macros, optionally filtered by query.",
  "macro-new": "Create a new macro.",
  "macro-edit": "Edit an existing macro.",
  "macro-delete": "Delete an existing macro.",
  "macro-show": "Show a macro and resolved preview.",
  "macro-find": "Open the macro picker filtered by query.",
  "macro-duplicate": "Duplicate a macro.",
};

export default function registerPiMacro(pi: ExtensionAPI): void {
  const handlers = createCommandHandlers({
    sendUserMessage: (text, options) => pi.sendUserMessage(text, options),
    openPicker: async (ctx, options) => openMacroPicker(ctx, {
      sendUserMessage: (text, sendOptions) => pi.sendUserMessage(text, sendOptions),
    }, options),
  });

  for (const [command, handler] of Object.entries(handlers)) {
    pi.registerCommand(command, {
      description: DESCRIPTIONS[command] ?? `/${command}`,
      // Macro name completions are intentionally skipped for Phase 4: the Pi completion API shape
      // was not obvious from the documented command handler examples.
      handler: (args, ctx) => handler(args, ctx as unknown as CommandContext),
    });
  }
}
