import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createCommandHandlers, type CommandContext } from "../src/commands.js";
import { openMacroPicker } from "../src/picker.js";

const DESCRIPTIONS: Record<string, string> = {
  macro: "Open macro picker, send a named macro, or manage macros with subcommands.",
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
