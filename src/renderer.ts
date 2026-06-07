import type { Macro, TemplateResolutionResult } from "./types.js";

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[P_^][\s\S]*?\x1b\\/g;

export interface PickerTheme {
  fg?: (color: string, text: string) => string;
  bg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export function visibleLength(text: string): number {
  return [...text.replace(ANSI_RE, "")].length;
}

export function padAnsi(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleLength(text)));
}

export function truncateAnsi(text: string, width: number, ellipsis = "…"): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const plain = text.replace(ANSI_RE, "");
  const limit = Math.max(0, width - visibleLength(ellipsis));
  return [...plain].slice(0, limit).join("") + ellipsis;
}

export function style(theme: PickerTheme | undefined, color: string, text: string): string {
  if (theme?.fg) return theme.fg(color, text);
  const codes: Record<string, string> = { accent: "36", muted: "2", dim: "2", border: "90", warning: "33", error: "31", success: "32", text: "39" };
  const code = codes[color] ?? codes.text;
  return `\x1b[${code}m${text}\x1b[0m`;
}

export function selectedStyle(theme: PickerTheme | undefined, text: string): string {
  if (theme?.bg) return theme.bg("selectedBg", style(theme, "accent", text));
  return `\x1b[7m${text}\x1b[27m`;
}

export function renderMacroRow(macro: Macro, selected: boolean, width: number, theme?: PickerTheme): string {
  const nameWidth = Math.min(22, Math.max(10, Math.floor(width * 0.32)));
  const prefix = selected ? "› " : "  ";
  const name = truncateAnsi(macro.name, nameWidth);
  const desc = macro.description ? style(theme, "muted", truncateAnsi(macro.description, Math.max(0, width - nameWidth - 3))) : "";
  const row = `${prefix}${padAnsi(selected ? style(theme, "accent", name) : name, nameWidth)} ${desc}`;
  return selected ? selectedStyle(theme, truncateAnsi(row, width)) : truncateAnsi(row, width);
}

export function formatPreview(preview: TemplateResolutionResult | undefined, width: number, height: number, theme?: PickerTheme): string[] {
  if (!preview) return [style(theme, "muted", "Preview unavailable.")];
  const prefix = preview.truncated ? style(theme, "warning", "preview truncated") : style(theme, "muted", "preview");
  const body = preview.text || style(theme, "muted", "(empty)");
  return [prefix, ...body.split("\n").slice(0, Math.max(1, height - 1)).map((line) => truncateAnsi(line, width))];
}
