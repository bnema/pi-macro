import type { Theme } from "@earendil-works/pi-coding-agent";

function matchesKey(data: string, key: string): boolean {
  const aliases: Record<string, string[]> = {
    escape: ["\u001b", "escape", "esc"],
    up: ["\u001b[A", "up"],
    down: ["\u001b[B", "down"],
    pageup: ["\u001b[5~", "pageup", "pageUp"],
    pagedown: ["\u001b[6~", "pagedown", "pageDown"],
    backspace: ["\u007f", "\b", "backspace"],
    enter: ["\r", "\n", "enter", "return"],
    return: ["\r", "\n", "enter", "return"],
    "ctrl+u": ["\u0015", "ctrl+u"],
    "ctrl+n": ["\u000e", "ctrl+n", "action:new"],
    "ctrl+e": ["\u0005", "ctrl+e", "action:edit"],
    "ctrl+d": ["\u0004", "ctrl+d", "action:delete"],
    "ctrl+y": ["\u0019", "ctrl+y", "action:duplicate"],
    "ctrl+p": ["\u0010", "ctrl+p", "action:preview"],
  };
  return (aliases[key] ?? [key]).includes(data);
}
import { collectTemplateContext } from "./context.js";
import { handleMacro, type CommandContext, type MacroCommandDeps } from "./commands.js";
import { isValidMacroName, MacroStore } from "./macro-store.js";
import { previewTemplate } from "./template.js";
import type { Macro, TemplateResolutionResult } from "./types.js";
import { formatPreview, padAnsi, renderMacroRow, style, truncateAnsi, visibleLength, type PickerTheme } from "./renderer.js";

export interface PickerOptions { query?: string; input?: string }

export interface PickerStateSnapshot {
  query: string;
  selectedIndex: number;
  scrollOffset: number;
  macros: Macro[];
  visibleMacros: Macro[];
  preview?: TemplateResolutionResult;
}

export class MacroPickerState {
  query: string;
  selectedIndex = 0;
  scrollOffset = 0;
  macros: Macro[] = [];
  visibleMacros: Macro[] = [];
  previewCache = new Map<string, TemplateResolutionResult>();

  constructor(query = "") { this.query = query; }

  setMacros(macros: Macro[]): void { this.macros = macros; this.recompute(); }
  setQuery(query: string): void { this.query = query; this.previewCache.clear(); this.recompute(); }
  clearQuery(): void { this.setQuery(""); }
  type(text: string): void { this.setQuery(this.query + text); }
  backspace(): void { this.setQuery([...this.query].slice(0, -1).join("")); }
  selected(): Macro | undefined { return this.visibleMacros[this.selectedIndex]; }
  move(delta: number): void { this.selectedIndex = clamp(this.selectedIndex + delta, 0, Math.max(0, this.visibleMacros.length - 1)); this.ensureVisible(); }
  page(delta: number, pageSize: number): void { this.move(delta * Math.max(1, pageSize)); }

  async refreshPreview(ctx: CommandContext, input = ""): Promise<void> {
    const macro = this.selected();
    if (!macro) return;
    const key = `${macro.name}\u0000${this.query}\u0000${input}`;
    if (!this.previewCache.has(key)) {
      try {
        this.previewCache.set(key, await previewTemplate(macro.body, await collectTemplateContext(input, ctx as Record<string, unknown>)));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.previewCache.set(key, { text: message, variables: [], truncated: false, requiresConfirmation: false, errors: [message] });
      }
    }
  }

  snapshot(input = ""): PickerStateSnapshot {
    const macro = this.selected();
    return { query: this.query, selectedIndex: this.selectedIndex, scrollOffset: this.scrollOffset, macros: this.macros, visibleMacros: this.visibleMacros, preview: macro ? this.previewCache.get(`${macro.name}\u0000${this.query}\u0000${input}`) : undefined };
  }

  private recompute(): void {
    const q = this.query.trim().toLowerCase();
    this.visibleMacros = q ? this.macros.filter((m) => m.name.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q) || m.body.toLowerCase().includes(q)) : [...this.macros];
    this.selectedIndex = clamp(this.selectedIndex, 0, Math.max(0, this.visibleMacros.length - 1));
    this.scrollOffset = clamp(this.scrollOffset, 0, Math.max(0, this.visibleMacros.length - 1));
    this.ensureVisible();
  }
  private ensureVisible(pageSize = 8): void {
    if (this.selectedIndex < this.scrollOffset) this.scrollOffset = this.selectedIndex;
    if (this.selectedIndex >= this.scrollOffset + pageSize) this.scrollOffset = Math.max(0, this.selectedIndex - pageSize + 1);
  }
}

function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
function hasTui(ctx: CommandContext): boolean { return ctx.mode === "tui" && ctx.hasUI === true && Boolean(ctx.ui); }
function requireUi(ctx: CommandContext): NonNullable<CommandContext["ui"]> { if (!ctx.ui) throw new Error("Macro picker requires Pi TUI UI APIs."); return ctx.ui; }

export async function openMacroPicker(ctx: CommandContext, deps: MacroCommandDeps, options: PickerOptions = {}): Promise<void> {
  if (!hasTui(ctx)) throw new Error("Macro picker is only available in Pi TUI mode. Use direct /macro commands in non-TUI modes.");
  const store = deps.store ?? new MacroStore();
  const state = new MacroPickerState(options.query ?? "");
  state.setMacros(await store.listMacros());

  type CustomUi = (factory: (tui: { requestRender: () => void }, theme: Theme, keybindings: unknown, done: () => void) => MacroPickerComponent, options: unknown) => Promise<void> | void;
  const custom = (ctx.ui as CommandContext["ui"] & { custom?: CustomUi }).custom;
  if (!custom) throw new Error("Macro picker requires Pi custom TUI API.");
  await custom((tui: { requestRender: () => void }, theme: Theme, _keybindings: unknown, done: () => void) => {
    const component = new MacroPickerComponent(state, ctx, { ...deps, store }, theme as unknown as Theme & PickerTheme, done, options.input ?? "");
    component.onChange = async () => { await component.reloadAndPreview(); tui.requestRender(); };
    void component.reloadAndPreview().then(() => tui.requestRender()).catch((error) => component.showError(error));
    return component;
  }, { overlay: true, overlayOptions: { width: "80%", minWidth: 64, maxHeight: "80%", anchor: "center", margin: 1 } });
}

class MacroPickerComponent {
  onChange?: () => Promise<void>;
  private message: { level: "info" | "warning" | "error"; text: string } | undefined;
  private searchMode = false;
  constructor(private state: MacroPickerState, private ctx: CommandContext, private deps: MacroCommandDeps, private theme: Theme & PickerTheme, private done: () => void, private input: string) {}
  invalidate(): void {}
  async reloadAndPreview(): Promise<void> { this.state.setMacros(await (this.deps.store ?? new MacroStore()).listMacros()); await this.state.refreshPreview(this.ctx, this.input); }
  showError(error: unknown): void { this.message = { level: "error", text: error instanceof Error ? error.message : String(error) }; }

  handleInput(data: string): void {
    const afterChange = () => { void this.onChange?.().catch((error) => this.showError(error)); };
    const run = (fn: () => Promise<void>) => { void fn().then(afterChange).catch((error) => this.showError(error)); };
    let changed = true;
    if (matchesKey(data, "escape")) { this.done(); return; }
    if (matchesKey(data, "up")) this.state.move(-1);
    else if (matchesKey(data, "down")) this.state.move(1);
    else if (matchesKey(data, "pageup")) this.state.page(-1, 8);
    else if (matchesKey(data, "pagedown")) this.state.page(1, 8);
    else if (matchesKey(data, "ctrl+u")) this.state.clearQuery();
    else if (matchesKey(data, "backspace")) { this.state.backspace(); if (!this.state.query) this.searchMode = false; }
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) { changed = false; run(() => this.sendSelected()); }
    else if (!this.searchMode && data === "n") { changed = false; run(() => this.createMacro()); }
    else if (!this.searchMode && data === "e") { changed = false; run(() => this.editSelected()); }
    else if (!this.searchMode && data === "d") { changed = false; run(() => this.deleteSelected()); }
    else if (!this.searchMode && data === "y") { changed = false; run(() => this.duplicateSelected()); }
    else if (!this.searchMode && data === "p") { changed = false; run(() => this.previewSelected()); }
    else if (matchesKey(data, "ctrl+n")) { changed = false; run(() => this.createMacro()); }
    else if (matchesKey(data, "ctrl+e")) { changed = false; run(() => this.editSelected()); }
    else if (matchesKey(data, "ctrl+d")) { changed = false; run(() => this.deleteSelected()); }
    else if (matchesKey(data, "ctrl+y")) { changed = false; run(() => this.duplicateSelected()); }
    else if (matchesKey(data, "ctrl+p")) { changed = false; run(() => this.previewSelected()); }
    else if (data === "/") { this.searchMode = true; this.state.clearQuery(); }
    else if (data.length === 1 && data.charCodeAt(0) >= 32) this.state.type(data);
    else changed = false;
    if (changed) afterChange();
  }

  render(width: number): string[] {
    const w = Math.min(Math.max(52, width), 96);
    const inner = w - 2;
    const row = (content = "") => style(this.theme, "border", "│") + padAnsi(truncateAnsi(content, inner), inner) + style(this.theme, "border", "│");
    const lines: string[] = [];
    lines.push(style(this.theme, "border", `╭─ ${style(this.theme, "accent", this.theme.bold?.("/macro") ?? "/macro")} ${"─".repeat(Math.max(0, inner - 9))}╮`));
    lines.push(row(` query: ${this.state.query}${style(this.theme, "dim", "▌")}`));
    lines.push(row(` ${style(this.theme, "muted", `${this.state.visibleMacros.length} macros · type filter · Enter send · n new · e edit · d delete · y duplicate · p preview · / search · Ctrl-U clear · Esc close`)}`));
    lines.push(row(` ${style(this.theme, "border", "─".repeat(Math.max(0, inner - 2)))}`));
    const listH = 8;
    if (this.state.macros.length === 0) lines.push(row(` ${style(this.theme, "muted", "No macros yet. Press n to create one.")}`));
    else if (this.state.visibleMacros.length === 0) lines.push(row(` ${style(this.theme, "warning", `No macro matching \"${this.state.query}\". Press n to create \"${this.state.query}\".`)}`));
    else for (const macro of this.state.visibleMacros.slice(this.state.scrollOffset, this.state.scrollOffset + listH)) lines.push(row(" " + renderMacroRow(macro, macro === this.state.selected(), inner - 2, this.theme)));
    while (lines.length < 4 + listH) lines.push(row(""));
    lines.push(row(` ${style(this.theme, "border", "─".repeat(Math.max(0, inner - 2)))}`));
    const snap = this.state.snapshot(this.input);
    for (const line of formatPreview(snap.preview, inner - 2, 8, this.theme)) lines.push(row(` ${line}`));
    if (this.message) lines.push(row(` ${style(this.theme, this.message.level === "error" ? "error" : this.message.level === "warning" ? "warning" : "muted", this.message.text)}`));
    lines.push(style(this.theme, "border", `╰${"─".repeat(inner)}╯`));
    return lines.map((line) => visibleLength(line) > width ? truncateAnsi(line, width, "") : line);
  }

  private selectedOrThrow(): Macro { const macro = this.state.selected(); if (!macro) throw new Error("No macro selected."); return macro; }
  private async sendSelected(): Promise<void> {
    const macro = this.selectedOrThrow();
    await this.state.refreshPreview(this.ctx, this.input);
    const preview = this.state.snapshot(this.input).preview;
    if (preview?.truncated) {
      const ui = requireUi(this.ctx);
      const message = `Preview for '${macro.name}' is truncated. The full resolved macro will be sent. Send anyway?`;
      if (!await ui.confirm?.("Send truncated macro?", message)) return;
    }
    await handleMacro(`${macro.name}${this.input ? ` ${this.input}` : ""}`, this.ctx, this.deps);
    this.done();
  }
  private async createMacro(): Promise<void> {
    const ui = requireUi(this.ctx); const seed = this.state.visibleMacros.length === 0 && isValidMacroName(this.state.query) ? this.state.query : undefined;
    const name = seed ?? await ui.input?.("Macro name", this.state.query); if (!name) return;
    const description = await ui.input?.("Description (optional)"); const body = await ui.editor?.("Macro body", ""); if (!body) return;
    await (this.deps.store ?? new MacroStore()).createMacro({ name, description: description || undefined, body }); this.message = { level: "info", text: `Created macro: ${name}` };
  }
  private async editSelected(): Promise<void> {
    const macro = this.selectedOrThrow();
    const ui = requireUi(this.ctx);
    const name = await ui.input?.("Macro name", macro.name);
    if (!name) return;
    const description = await ui.input?.("Description (optional)", macro.description);
    const body = await ui.editor?.("Macro body", macro.body);
    if (!body) return;
    const store = this.deps.store ?? new MacroStore();
    await store.updateMacro(macro.name, { name, description: description || undefined, body });
  }

  private async deleteSelected(): Promise<void> {
    const macro = this.selectedOrThrow();
    const ui = requireUi(this.ctx);
    if (!await ui.confirm?.("Delete macro", `Delete macro '${macro.name}'?`)) return;
    const store = this.deps.store ?? new MacroStore();
    await store.deleteMacro(macro.name);
  }

  private async duplicateSelected(): Promise<void> {
    const macro = this.selectedOrThrow();
    const ui = requireUi(this.ctx);
    const target = await ui.input?.("New macro name", `${macro.name}-copy`);
    if (!target) return;
    const store = this.deps.store ?? new MacroStore();
    await store.duplicateMacro(macro.name, target);
  }

  private async previewSelected(): Promise<void> {
    const macro = this.selectedOrThrow();
    const templateContext = await collectTemplateContext(this.input, this.ctx as Record<string, unknown>);
    const preview = await previewTemplate(macro.body, templateContext);
    const ui = requireUi(this.ctx);
    await ui.confirm?.(`Preview ${macro.name}`, `${preview.text}\n\nPress Enter from the picker to send.`);
  }
}
