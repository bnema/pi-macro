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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function rowColumnWidths(width: number): { name: number; description: number; body: number } {
  const prefixWidth = 2;
  const gaps = 2;
  const columns = Math.max(0, width - prefixWidth - gaps);
  let name = clampNumber(Math.floor(columns * 0.2), 8, 20);
  let description = clampNumber(Math.floor(columns * 0.3), 10, 34);
  let body = columns - name - description;
  if (body < 8) {
    const needed = 8 - body;
    const fromDescription = Math.min(needed, Math.max(0, description - 8));
    description -= fromDescription;
    body += fromDescription;
    const fromName = Math.min(8 - body, Math.max(0, name - 6));
    name -= fromName;
    body += fromName;
  }
  if (body < 0) body = 0;
  return { name, description, body };
}

function oneLineBody(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}

export function renderMacroRow(macro: Macro, selected: boolean, width: number, theme?: PickerTheme): string {
  const { name: nameWidth, description: descriptionWidth, body: bodyWidth } = rowColumnWidths(width);
  const prefix = selected ? "› " : "  ";
  const name = truncateAnsi(macro.name, nameWidth);
  const description = truncateAnsi(macro.description ?? "", descriptionWidth);
  const body = truncateAnsi(oneLineBody(macro.body), bodyWidth);
  const row = [
    prefix + padAnsi(selected ? style(theme, "accent", name) : name, nameWidth),
    padAnsi(description ? style(theme, "muted", description) : "", descriptionWidth),
    body,
  ].join(" ");
  const padded = padAnsi(truncateAnsi(row, width), width);
  return selected ? selectedStyle(theme, padded) : padded;
}

export function formatPreview(preview: TemplateResolutionResult | undefined, width: number, height: number, theme?: PickerTheme): string[] {
  if (!preview) return [style(theme, "muted", "Preview unavailable.")];
  const prefix = preview.truncated ? style(theme, "warning", "preview truncated") : style(theme, "muted", "preview");
  const body = preview.text || style(theme, "muted", "(empty)");
  return [prefix, ...body.split("\n").slice(0, Math.max(1, height - 1)).map((line) => truncateAnsi(line, width))];
}
