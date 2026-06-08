import type { Macro } from "./types.js";
import { collectTemplateContext } from "./context.js";
import { MacroStore, isValidMacroName } from "./macro-store.js";
import { previewTemplate, resolveTemplate } from "./template.js";

export interface SendOptions { deliverAs?: "followUp" }
export type SendUserMessage = (text: string, options?: SendOptions) => Promise<void> | void;

export interface CommandUI {
  notify?: (message: string, level?: "info" | "warning" | "error") => void;
  input?: (title: string, placeholder?: string, opts?: unknown) => Promise<string | undefined> | string | undefined;
  editor?: (title: string, prefill?: string) => Promise<string | undefined> | string | undefined;
  select?: (title: string, options: string[], opts?: unknown) => Promise<string | undefined> | string | undefined;
  confirm?: (title: string, message: string, opts?: unknown) => Promise<boolean> | boolean;
}

export interface CommandContext {
  mode?: string;
  hasUI?: boolean;
  ui?: CommandUI;
  cwd?: string;
  isIdle?: () => boolean;
  [key: string]: unknown;
}

export interface MacroCommandDeps {
  store?: MacroStore;
  sendUserMessage: SendUserMessage;
  openPicker?: (ctx: CommandContext, options?: { query?: string }) => Promise<void> | void;
}

export function parseMacroArgs(args: string): { name?: string; input: string } {
  const raw = args.trimStart();
  if (!raw) return { input: "" };
  const match = raw.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  return { name: match?.[1], input: match?.[2] ?? "" };
}

function storeOf(deps: MacroCommandDeps): MacroStore { return deps.store ?? new MacroStore(); }
function hasUI(ctx: CommandContext): boolean { return ctx.hasUI === true && Boolean(ctx.ui); }
function notify(ctx: CommandContext, message: string, level: "info" | "warning" | "error" = "info"): void { if (ctx.hasUI) ctx.ui?.notify?.(message, level); }
function output(ctx: CommandContext, value: unknown, fallback: string): void {
  const text = ctx.mode === "json" ? JSON.stringify(value) : fallback;
  if (ctx.hasUI) ctx.ui?.notify?.(text, "info");
  else (ctx as CommandContext & { output?: string }).output = text;
}
function err(message: string): Error { return new Error(message); }

async function promptText(ctx: CommandContext, label: string, initialValue?: string): Promise<string> {
  if (!hasUI(ctx) || !ctx.ui?.input) throw err(`${label} is required in non-interactive mode.`);
  const value = await ctx.ui.input(label, initialValue);
  if (!value) throw err("Cancelled.");
  return value;
}
async function promptBody(ctx: CommandContext, initialValue = ""): Promise<string> {
  if (!hasUI(ctx) || !ctx.ui?.editor) throw err("Macro body is required in non-interactive mode.");
  const value = await ctx.ui.editor("Macro body", initialValue);
  if (!value) throw err("Cancelled.");
  return value;
}
async function confirm(ctx: CommandContext, message: string, title = "Confirm"): Promise<boolean> {
  if (!hasUI(ctx) || !ctx.ui?.confirm) throw err("UI unavailable for confirmation.");
  return Boolean(await ctx.ui.confirm(title, message));
}
function filter(macros: Macro[], query: string): Macro[] {
  const q = query.trim().toLowerCase();
  if (!q) return macros;
  return macros.filter((m) => m.name.toLowerCase().includes(q) || m.body.toLowerCase().includes(q));
}

const SUBCOMMANDS = new Set(["list", "new", "edit", "delete", "show", "find", "duplicate", "send"]);

export function parseMacroSubcommand(args: string): { subcommand?: string; rest: string } {
  const parsed = parseMacroArgs(args);
  if (!parsed.name || !SUBCOMMANDS.has(parsed.name)) return { rest: args.trimStart() };
  return { subcommand: parsed.name, rest: parsed.input };
}

export async function handleMacro(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const subcommand = parseMacroSubcommand(args);
  if (subcommand.subcommand) {
    switch (subcommand.subcommand) {
      case "list": return handleMacroList(subcommand.rest, ctx, deps);
      case "new": return handleMacroNew(subcommand.rest, ctx, deps);
      case "edit": return handleMacroEdit(subcommand.rest, ctx, deps);
      case "delete": return handleMacroDelete(subcommand.rest, ctx, deps);
      case "show": return handleMacroShow(subcommand.rest, ctx, deps);
      case "find": return handleMacroFind(subcommand.rest, ctx, deps);
      case "duplicate": return handleMacroDuplicate(subcommand.rest, ctx, deps);
      case "send": return sendMacro(subcommand.rest, ctx, deps);
    }
  }
  await sendMacro(args, ctx, deps);
}

async function sendMacro(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const parsed = parseMacroArgs(args);
  if (!parsed.name) {
    if (!hasUI(ctx)) throw err("/macro requires a name in non-interactive mode.");
    if (!deps.openPicker) throw err("Macro picker is not available yet.");
    await deps.openPicker(ctx);
    return;
  }
  if (!isValidMacroName(parsed.name)) throw err(`Invalid macro name: ${parsed.name}.`);
  const store = storeOf(deps);
  const macro = await store.getMacro(parsed.name);
  if (!macro) {
    if (hasUI(ctx) && await confirm(ctx, `Macro '${parsed.name}' not found. Create it?`)) {
      await createMacroFlow(store, ctx, parsed.name);
      return;
    }
    throw err(`Macro not found: ${parsed.name}.`);
  }
  const tctx = await collectTemplateContext(parsed.input, ctx as Record<string, unknown>);
  const interactors = {
    input: (q: string) => promptText(ctx, q),
    select: async (q: string, opts: string[]) => {
      if (!hasUI(ctx) || !ctx.ui?.select) throw err("Selection is required in non-interactive mode.");
      const value = await ctx.ui.select(q, opts); if (!value) throw err("Cancelled."); return value;
    },
    confirm: (q: string) => confirm(ctx, q),
  };
  const result = await resolveTemplate(macro.body, tctx, interactors, { flow: "direct" });
  if (result.requiresConfirmation) {
    if (!await confirm(ctx, `Send macro '${macro.name}'?\n\n${result.text}`)) throw err("Cancelled.");
  }
  await deps.sendUserMessage(result.text, ctx.isIdle?.() === false ? { deliverAs: "followUp" } : undefined);
  notify(ctx, `Sent macro: ${macro.name}`, "info");
}

async function createMacroFlow(store: MacroStore, ctx: CommandContext, name?: string): Promise<Macro> {
  const finalName = name ?? await promptText(ctx, "Macro name");
  if (!isValidMacroName(finalName)) throw err(`Invalid macro name: ${finalName}.`);
  const body = await promptBody(ctx);
  const macro = await store.createMacro({ name: finalName, body });
  notify(ctx, `Created macro: ${macro.name}`, "info");
  return macro;
}

export async function handleMacroList(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const macros = filter(await storeOf(deps).listMacros(), args);
  const text = macros.length ? macros.map((m) => m.name).join("\n") : "No macros found.";
  output(ctx, macros, text);
}
export async function handleMacroNew(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const name = parseMacroArgs(args).name;
  await createMacroFlow(storeOf(deps), ctx, name);
}
export async function handleMacroEdit(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const { name } = parseMacroArgs(args);
  if (!name) throw err("/macro edit requires a name.");
  const store = storeOf(deps);
  const macro = await store.getMacro(name);
  if (!macro) throw err(`Macro not found: ${name}.`);
  if (!hasUI(ctx)) throw err("/macro edit requires UI input/editor.");
  const nextName = await promptText(ctx, "Macro name", macro.name);
  const body = await promptBody(ctx, macro.body);
  const updated = await store.updateMacro(macro.name, { name: nextName, body });
  notify(ctx, `Updated macro: ${updated.name}`, "info");
}
export async function handleMacroDelete(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const { name } = parseMacroArgs(args);
  if (!name) throw err("/macro delete requires a name.");
  if (!hasUI(ctx)) throw err("/macro delete requires interactive confirmation.");
  if (!await confirm(ctx, `Delete macro '${name}'?`, "Delete macro")) throw err("Cancelled.");
  await storeOf(deps).deleteMacro(name);
  notify(ctx, `Deleted macro: ${name}`, "info");
}
export async function handleMacroShow(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const { name, input } = parseMacroArgs(args);
  if (!name) throw err("/macro show requires a name.");
  const macro = await storeOf(deps).getMacro(name);
  if (!macro) throw err(`Macro not found: ${name}.`);
  const templateContext = await collectTemplateContext(input, ctx as Record<string, unknown>);
  const preview = await previewTemplate(macro.body, templateContext);
  output(
    ctx,
    { ...macro, preview: preview.text },
    `${macro.name}\n${macro.body}\n\nPreview:\n${preview.text}`,
  );
}
export async function handleMacroFind(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  if (!hasUI(ctx)) throw err("/macro find requires an interactive UI.");
  if (!deps.openPicker) throw err("Macro picker is not available yet.");
  await deps.openPicker(ctx, { query: args.trim() });
}
export async function handleMacroDuplicate(args: string, ctx: CommandContext, deps: MacroCommandDeps): Promise<void> {
  const { name: source, input } = parseMacroArgs(args);
  if (!source) throw err("/macro duplicate requires a source name.");
  const target = input.trim() || await promptText(ctx, "New macro name");
  const macro = await storeOf(deps).duplicateMacro(source, target);
  notify(ctx, `Duplicated macro: ${source} -> ${macro.name}`, "info");
}

export function createCommandHandlers(deps: MacroCommandDeps) {
  return {
    macro: (args: string, ctx: CommandContext) => handleMacro(args, ctx, deps),
  };
}
