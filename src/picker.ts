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
    tab: ["\t", "tab"],
    "shift+tab": ["\u001b[Z", "shift+tab"],
    delete: ["\u001b[3~", "delete"],
    left: ["\u001b[D", "left"],
    right: ["\u001b[C", "right"],
    home: ["\u001b[H", "\u001b[1~", "home"],
    end: ["\u001b[F", "\u001b[4~", "end"],
    "ctrl+u": ["\u0015", "ctrl+u"],
    "ctrl+s": ["\u0013", "ctrl+s"],
    "ctrl+o": ["\u000f", "ctrl+o"],
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
import { filterMacros } from "./macro-query.js";
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

  setMacros(macros: Macro[]): void { this.macros = macros; this.previewCache.clear(); this.recompute(); }
  setQuery(query: string): void { this.query = query; this.previewCache.clear(); this.recompute(); }
  selectByName(name: string): void { const index = this.visibleMacros.findIndex((m) => m.name === name); if (index >= 0) { this.selectedIndex = index; this.ensureVisible(); } }
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
    this.visibleMacros = filterMacros(this.macros, this.query);
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
function isTextInputChunk(data: string): boolean {
  if (data.length === 0) return false;
  return [...data].every((ch) => {
    if (ch === "\n" || ch === "\r" || ch === "\t") return true;
    const code = ch.charCodeAt(0);
    return code >= 32 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f);
  });
}
function normalizeTextInput(text: string): string { return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"); }
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
function trailingMarkerPrefixLength(text: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, text.length); length >= 1; length--) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}
const ANSI_TOKEN_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[P_^][\s\S]*?\x1b\\/g;
function splitAnsiTokens(text: string): string[] {
  const tokens: string[] = [];
  ANSI_TOKEN_RE.lastIndex = 0;
  let offset = 0;
  for (const match of text.matchAll(ANSI_TOKEN_RE)) {
    if (match.index > offset) tokens.push(...[...text.slice(offset, match.index)]);
    tokens.push(match[0]);
    offset = match.index + match[0].length;
  }
  if (offset < text.length) tokens.push(...[...text.slice(offset)]);
  return tokens;
}
function wrapVisibleTokens(tokens: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  for (const token of tokens) {
    const tokenWidth = visibleLength(token);
    if (line && lineWidth + tokenWidth > width) {
      lines.push(line);
      line = "";
      lineWidth = 0;
    }
    line += token;
    lineWidth += tokenWidth;
  }
  lines.push(line);
  return lines;
}
type CustomUi = (factory: (tui: { requestRender: () => void }, theme: Theme, keybindings: unknown, done: () => void) => MacroPickerComponent, options: unknown) => Promise<void> | void;
function getCustomUi(ctx: CommandContext): CustomUi | undefined {
  if (ctx.hasUI !== true || !ctx.ui) return undefined;
  const custom = (ctx.ui as CommandContext["ui"] & { custom?: unknown }).custom;
  return typeof custom === "function" ? custom as CustomUi : undefined;
}
export async function openMacroPicker(ctx: CommandContext, deps: MacroCommandDeps, options: PickerOptions = {}): Promise<void> {
  const custom = getCustomUi(ctx);
  if (!custom) throw new Error("Macro picker requires interactive custom UI support. Use direct /macro commands in non-interactive modes.");
  const store = deps.store ?? new MacroStore();
  const state = new MacroPickerState(options.query ?? "");
  state.setMacros(await store.listMacros());
  await custom((tui: { requestRender: () => void }, theme: Theme, _keybindings: unknown, done: () => void) => {
    const component = new MacroPickerComponent(state, ctx, { ...deps, store }, theme as unknown as Theme & PickerTheme, done, options.input ?? "");
    component.onRequestRender = () => tui.requestRender();
    component.onChange = async () => { await component.reloadAndPreview(); tui.requestRender(); };
    void component.reloadAndPreview().then(() => tui.requestRender()).catch((error) => component.showError(error));
    return component;
  }, { overlay: true, overlayOptions: { width: "90%", maxHeight: "80%", anchor: "center" } });
}

type PickerMode = "list" | "form" | "confirmDelete" | "preview";
type FormMode = "create" | "edit" | "duplicate";
type FormField = "name" | "tag" | "body";
interface PickerForm { mode: FormMode; sourceName?: string; fields: Record<FormField, string>; focus: FormField; cursors: Record<FormField, number>; error?: string }
const formFields: FormField[] = ["name", "tag", "body"];

class MacroPickerComponent {
  onChange?: () => Promise<void>;
  onRequestRender?: () => void;
  private message: { level: "info" | "warning" | "error"; text: string } | undefined;
  private searchMode = false;
  private mode: PickerMode = "list";
  private form?: PickerForm;
  private preview?: TemplateResolutionResult;
  private pendingMutation = false;
  private pasteBuffer = "";
  private pendingPasteStart = "";
  private isInPaste = false;
  constructor(private state: MacroPickerState, private ctx: CommandContext, private deps: MacroCommandDeps, private theme: Theme & PickerTheme, private done: () => void, private input: string) {}
  invalidate(): void {}
  async reloadAndPreview(): Promise<void> { this.state.setMacros(await (this.deps.store ?? new MacroStore()).listMacros()); await this.state.refreshPreview(this.ctx, this.input); }
  showError(error: unknown): void { this.message = { level: "error", text: error instanceof Error ? error.message : String(error) }; this.requestRender(); }
  private requestRender(): void { this.onRequestRender?.(); }

  handleInput(data: string): void {
    const afterChange = () => { void this.onChange?.().catch((error) => this.showError(error)); };
    const run = (fn: () => Promise<void>) => { void fn().then(afterChange).catch((error) => this.showError(error)); };
    const runSync = (fn: () => void) => { try { fn(); this.requestRender(); } catch (error) { this.showError(error); } };
    if (this.mode === "form") {
      if (this.handleBracketedPasteInput(data, () => this.requestRender())) return;
      this.handleFormInput(data);
      return;
    }
    if (this.mode === "confirmDelete") {
      if (this.pendingMutation) return;
      if (matchesKey(data, "escape") || data === "n") { this.mode = "list"; this.message = undefined; this.requestRender(); return; }
      if (data === "y") run(() => this.confirmDelete());
      return;
    }
    if (this.mode === "preview") { if (matchesKey(data, "escape")) { this.mode = "list"; this.requestRender(); } return; }
    let changed = true;
    if (this.handleBracketedPasteInput(data, afterChange)) return;
    if (matchesKey(data, "escape")) { this.done(); return; }
    if (matchesKey(data, "up")) this.state.move(-1);
    else if (matchesKey(data, "down")) this.state.move(1);
    else if (matchesKey(data, "pageup")) this.state.page(-1, 8);
    else if (matchesKey(data, "pagedown")) this.state.page(1, 8);
    else if (matchesKey(data, "ctrl+u")) this.state.clearQuery();
    else if (matchesKey(data, "backspace")) { this.state.backspace(); if (!this.state.query) this.searchMode = false; }
    else if (matchesKey(data, "enter") || matchesKey(data, "return")) { changed = false; run(() => this.sendSelected()); }
    else if (!this.searchMode && data === "n") { changed = false; runSync(() => this.openCreateForm()); }
    else if (!this.searchMode && data === "e") { changed = false; runSync(() => this.openEditForm()); }
    else if (!this.searchMode && data === "d") { changed = false; runSync(() => this.openDeleteConfirm()); }
    else if (!this.searchMode && data === "y") { changed = false; runSync(() => this.openDuplicateForm()); }
    else if (!this.searchMode && data === "p") { changed = false; run(() => this.openPreview()); }
    else if (matchesKey(data, "ctrl+n")) { changed = false; runSync(() => this.openCreateForm()); }
    else if (matchesKey(data, "ctrl+e")) { changed = false; runSync(() => this.openEditForm()); }
    else if (matchesKey(data, "ctrl+d")) { changed = false; runSync(() => this.openDeleteConfirm()); }
    else if (matchesKey(data, "ctrl+y")) { changed = false; runSync(() => this.openDuplicateForm()); }
    else if (matchesKey(data, "ctrl+p")) { changed = false; run(() => this.openPreview()); }
    else if (data === "/") { this.searchMode = true; this.state.clearQuery(); }
    else if (isTextInputChunk(data)) this.state.type(normalizeTextInput(data));
    else changed = false;
    if (changed) afterChange();
  }

  render(width: number): string[] {
    const frameWidth = Math.max(20, width);
    const inner = Math.max(10, frameWidth - 2);
    const row = (content = "") => style(this.theme, "border", "│") + padAnsi(truncateAnsi(content, inner), inner) + style(this.theme, "border", "│");
    const border = (text: string) => style(this.theme, "border", text);
    const title = this.theme.bold?.("/macro") ?? "/macro";
    const lines: string[] = [];
    lines.push(`${border("╭─ ")}${style(this.theme, "accent", title)}${border(` ${"─".repeat(Math.max(0, inner - visibleLength(title) - 3))}╮`)}`);
    if (this.mode === "form" && this.form) {
      lines.push(row(` ${style(this.theme, "accent", `${this.form.mode} macro`)} · ${style(this.theme, "muted", "Tab fields · Enter save · Ctrl-O newline · Esc cancel")}`));
      for (const f of formFields) {
        for (const formRow of this.renderFormFieldRows(f, inner)) lines.push(row(formRow));
      }
      if (this.form.error) lines.push(row(` ${style(this.theme, "error", this.form.error)}`));
    } else if (this.mode === "confirmDelete") {
      const macro = this.state.selected();
      lines.push(row(` ${style(this.theme, "warning", `Delete macro '${macro?.name ?? ""}'?`)}`));
      lines.push(row(` ${style(this.theme, "muted", "Press y to delete, n or Esc to cancel.")}`));
    } else if (this.mode === "preview") {
      const macro = this.state.selected();
      lines.push(row(` ${style(this.theme, "accent", `Preview: ${macro?.name ?? ""}`)} · Esc back`));
      for (const line of formatPreview(this.preview, inner - 2, 14, this.theme)) lines.push(row(` ${line}`));
    } else {
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
    }
    if (this.message) lines.push(row(` ${style(this.theme, this.message.level === "error" ? "error" : this.message.level === "warning" ? "warning" : "muted", this.message.text)}`));
    lines.push(border(`╰${"─".repeat(inner)}╯`));
    return lines.map((line) => visibleLength(line) > frameWidth ? truncateAnsi(line, frameWidth, "") : line);
  }

  private selectedOrThrow(): Macro { const macro = this.state.selected(); if (!macro) throw new Error("No macro selected."); return macro; }
  private async sendSelected(): Promise<void> {
    const macro = this.selectedOrThrow();
    await this.state.refreshPreview(this.ctx, this.input);
    await handleMacro(`send ${macro.name}${this.input ? ` ${this.input}` : ""}`, this.ctx, this.deps);
    this.done();
  }
  private openCreateForm(): void { const seed = this.state.visibleMacros.length === 0 && isValidMacroName(this.state.query) ? this.state.query : ""; this.openForm("create", { name: seed, tag: "", body: "" }); }
  private openEditForm(): void { const m = this.selectedOrThrow(); this.openForm("edit", { name: m.name, tag: m.tag, body: m.body }, m.name); }
  private openDuplicateForm(): void { const m = this.selectedOrThrow(); this.openForm("duplicate", { name: `${m.name}-copy`, tag: m.tag, body: m.body }, m.name); }
  private openDeleteConfirm(): void { this.selectedOrThrow(); this.mode = "confirmDelete"; this.message = undefined; }
  private openForm(mode: FormMode, fields: Record<FormField, string>, sourceName?: string): void { this.mode = "form"; this.message = undefined; this.form = { mode, sourceName, fields, focus: "name", cursors: { name: fields.name.length, tag: fields.tag.length, body: fields.body.length } }; }
  private handleFormInput(data: string): void {
    const form = this.form!; const field = form.focus; const value = form.fields[field]; const cursor = form.cursors[field]; form.error = undefined;
    if (this.pendingMutation) return;
    if (matchesKey(data, "escape")) { this.mode = "list"; this.form = undefined; this.requestRender(); return; }
    if (matchesKey(data, "ctrl+s")) { void this.saveForm().then(() => this.requestRender()).catch((error) => this.showFormError(error)); return; }
    if (matchesKey(data, "tab")) { form.focus = formFields[(formFields.indexOf(field) + 1) % formFields.length]!; this.requestRender(); return; }
    if (matchesKey(data, "shift+tab")) { form.focus = formFields[(formFields.indexOf(field) + formFields.length - 1) % formFields.length]!; this.requestRender(); return; }
    if (matchesKey(data, "ctrl+u")) { form.fields[field] = ""; form.cursors[field] = 0; this.requestRender(); return; }
    if (matchesKey(data, "left")) { form.cursors[field] = Math.max(0, cursor - 1); this.requestRender(); return; }
    if (matchesKey(data, "right")) { form.cursors[field] = Math.min(value.length, cursor + 1); this.requestRender(); return; }
    if (matchesKey(data, "home")) { form.cursors[field] = 0; this.requestRender(); return; }
    if (matchesKey(data, "end")) { form.cursors[field] = value.length; this.requestRender(); return; }
    if (matchesKey(data, "backspace")) { if (cursor > 0) { form.fields[field] = value.slice(0, cursor - 1) + value.slice(cursor); form.cursors[field] = cursor - 1; } this.requestRender(); return; }
    if (matchesKey(data, "delete")) { form.fields[field] = value.slice(0, cursor) + value.slice(cursor + 1); this.requestRender(); return; }
    if (matchesKey(data, "ctrl+o")) { if (field === "body") this.insertText("\n"); this.requestRender(); return; }
    if (matchesKey(data, "enter") || matchesKey(data, "return")) { void this.saveForm().then(() => this.requestRender()).catch((error) => this.showFormError(error)); return; }
    if (isTextInputChunk(data)) this.insertText(normalizeTextInput(data));
    this.requestRender();
  }
  private handleBracketedPasteInput(data: string, afterPaste: () => void): boolean {
    const hadPendingPasteStart = this.pendingPasteStart.length > 0;
    if (hadPendingPasteStart) {
      data = this.pendingPasteStart + data;
      this.pendingPasteStart = "";
    }

    if (this.isInPaste) return this.consumeBracketedPaste(data, afterPaste);

    const startIndex = data.indexOf(BRACKETED_PASTE_START);
    if (startIndex === -1) {
      const partialLength = trailingMarkerPrefixLength(data, BRACKETED_PASTE_START);
      if (partialLength > 0 && data !== "\u001b") {
        const beforePartial = data.slice(0, -partialLength);
        if (beforePartial.length > 0) this.handleInput(beforePartial);
        this.pendingPasteStart = data.slice(-partialLength);
        return true;
      }
      if (hadPendingPasteStart) {
        this.handleInput(data);
        return true;
      }
      return false;
    }

    const beforePaste = data.slice(0, startIndex);
    if (beforePaste.length > 0) this.handleInput(beforePaste);
    this.isInPaste = true;
    this.pasteBuffer = "";
    return this.consumeBracketedPaste(data.slice(startIndex + BRACKETED_PASTE_START.length), afterPaste);
  }
  private consumeBracketedPaste(data: string, afterPaste: () => void): boolean {
    this.pasteBuffer += data;
    const endIndex = this.pasteBuffer.indexOf(BRACKETED_PASTE_END);
    if (endIndex === -1) return true;

    const pasteContent = this.pasteBuffer.substring(0, endIndex);
    const remaining = this.pasteBuffer.substring(endIndex + BRACKETED_PASTE_END.length);
    this.isInPaste = false;
    this.pasteBuffer = "";

    if (pasteContent.length > 0) {
      this.insertTextInput(normalizeTextInput(pasteContent));
      afterPaste();
    }
    if (remaining.length > 0) this.handleInput(remaining);
    return true;
  }
  private insertTextInput(text: string): void {
    if (this.mode === "form") this.insertText(text);
    else this.state.type(text);
  }
  private renderFormFieldRows(field: FormField, innerWidth: number): string[] {
    const form = this.form!;
    const active = form.focus === field;
    const marker = active ? style(this.theme, "accent", "›") : " ";
    const label = style(this.theme, "muted", `${field}:`);
    const prefix = `${marker} ${label} `;
    const continuationPrefix = " ".repeat(visibleLength(prefix));
    const valueWidth = Math.max(1, innerWidth - visibleLength(prefix));
    return this.renderFormValue(field, valueWidth).map((value, index) => `${index === 0 ? prefix : continuationPrefix}${value}`);
  }
  private renderFormValue(field: FormField, width: number): string[] {
    const form = this.form!;
    const raw = form.fields[field];
    const cursor = form.focus === field ? form.cursors[field] : -1;
    const display = raw.replace(/\n/g, "↵");
    const displayCursor = cursor < 0 ? -1 : raw.slice(0, cursor).replace(/\n/g, "↵").length;
    if (displayCursor < 0) return display ? wrapVisibleTokens(splitAnsiTokens(display), width) : [style(this.theme, "dim", field === "body" ? "(prompt body)" : "(empty)")];
    const clampedCursor = clamp(displayCursor, 0, display.length);
    const tokens: string[] = [];
    let offset = 0;
    let cursorRendered = false;
    for (const token of splitAnsiTokens(display)) {
      const tokenWidth = visibleLength(token);
      const nextOffset = offset + token.length;
      const cursorAtToken = !cursorRendered && clampedCursor <= offset;
      const cursorInsideVisibleToken = !cursorRendered && tokenWidth > 0 && clampedCursor < nextOffset;
      if (cursorAtToken || cursorInsideVisibleToken) {
        if (tokenWidth > 0) {
          tokens.push(style(this.theme, "accent", `▌${token}`));
          cursorRendered = true;
          offset = nextOffset;
          continue;
        }
        tokens.push(style(this.theme, "accent", "▌ "));
        cursorRendered = true;
      }
      tokens.push(token);
      offset = nextOffset;
    }
    if (!cursorRendered) tokens.push(style(this.theme, "accent", "▌ "));
    return wrapVisibleTokens(tokens, width);
  }
  private insertText(text: string): void { const f = this.form!; const field = f.focus; const cursor = f.cursors[field]; f.fields[field] = f.fields[field].slice(0, cursor) + text + f.fields[field].slice(cursor); f.cursors[field] = cursor + text.length; }
  private showFormError(error: unknown): void { if (this.form) { this.form.error = error instanceof Error ? error.message : String(error); this.requestRender(); } else this.showError(error); }
  private async saveForm(): Promise<void> {
    const form = this.form!; const name = form.fields.name.trim(); const body = form.fields.body;
    if (!name) { form.error = "Name is required."; return; }
    if (!isValidMacroName(name)) { form.error = "Invalid macro name."; return; }
    if (!body.trim()) { form.error = "Body is required."; return; }
    const tag = form.fields.tag.trim();
    const store = this.deps.store ?? new MacroStore(); let saved: Macro;
    this.pendingMutation = true;
    try {
      if (form.mode === "create" || form.mode === "duplicate") saved = await store.createMacro({ name, tag, body });
      else saved = await store.updateMacro(form.sourceName!, { name, tag, body });
      this.state.setMacros(await store.listMacros());
      if (!this.state.visibleMacros.some((m) => m.name === saved.name)) this.state.clearQuery();
      this.state.selectByName(saved.name);
      await this.state.refreshPreview(this.ctx, this.input);
      this.mode = "list"; this.form = undefined; this.message = { level: "info", text: `${form.mode === "edit" ? "Updated" : "Saved"} macro: ${saved.name}` };
    } finally {
      this.pendingMutation = false;
    }
  }
  private async confirmDelete(): Promise<void> {
    const m = this.selectedOrThrow(); const store = this.deps.store ?? new MacroStore();
    this.pendingMutation = true;
    try {
      await store.deleteMacro(m.name); this.state.setMacros(await store.listMacros()); this.mode = "list"; this.message = { level: "info", text: `Deleted macro: ${m.name}` };
    } finally {
      this.pendingMutation = false;
    }
  }
  private async openPreview(): Promise<void> { const macro = this.selectedOrThrow(); this.preview = await previewTemplate(macro.body, await collectTemplateContext(this.input, this.ctx as Record<string, unknown>)); this.mode = "preview"; this.requestRender(); }
}
