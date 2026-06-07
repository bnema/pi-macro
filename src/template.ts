import type { TemplateInteractors, TemplateResolutionContext, TemplateResolutionOptions, TemplateResolutionResult, TemplateVariable, TemplateVariableRisk } from "./types.js";

const SIMPLE_VARIABLES = new Set([
  "input", "args", "cwd", "project", "git_branch", "git_status", "git_diff", "current_file", "current_file_path", "editor", "diagnostics",
  "last_user_message", "last_assistant_message", "last_message", "last_code_block", "date", "datetime", "session_name", "model",
]);
const INTERACTIVE = new Set(["ask", "choice", "confirm"]);
const ESC = "\u0000PI_MACRO_ESC_OPEN\u0000";

export const EXPANSION_LIMITS = {
  previewPerVarChars: 12_000,
  previewPerVarLines: 300,
  previewTotalChars: 24_000,
  sendPerVarChars: 60_000,
  sendTotalChars: 120_000,
};

export class TemplateError extends Error {
  constructor(message: string, public readonly code = "template-error") { super(message); this.name = "TemplateError"; }
}

export function findVariables(body: string): TemplateVariable[] {
  const source = body.replaceAll("\\{{", ESC);
  if (source.includes("{{") || source.includes("}}")) {
    // parsed below; remaining unmatched braces are checked after the scan
  }
  const vars: TemplateVariable[] = [];
  let pos = 0;
  while (true) {
    const start = source.indexOf("{{", pos);
    if (start < 0) break;
    const end = source.indexOf("}}", start + 2);
    if (end < 0) throw new TemplateError(`Malformed variable starting at ${start}: missing closing }}.`, "malformed-variable");
    const expression = source.slice(start + 2, end);
    if (/\s/.test(expression)) throw new TemplateError("Whitespace inside variable braces is invalid.", "invalid-whitespace");
    if (expression.length === 0) throw new TemplateError("Malformed variable: empty expression.", "malformed-variable");
    const variable = parseExpression(expression, start, end + 2);
    vars.push(variable);
    pos = end + 2;
  }
  const stripped = source.replace(new RegExp(`${ESC}[^}]*}}`, "g"), "").replace(/\{\{[^]*?\}\}/g, "");
  if (stripped.includes("}}")) throw new TemplateError("Malformed variable: stray closing }}.", "malformed-variable");
  return vars;
}

function parseExpression(expression: string, start: number, end: number): TemplateVariable {
  const colon = expression.indexOf(":");
  if (colon < 0) {
    if (!SIMPLE_VARIABLES.has(expression)) throw new TemplateError(`Unknown variable: ${expression}.`, "unknown-variable");
    return { raw: `{{${expression}}}`, expression, name: expression, start, end, interactive: false };
  }
  const name = expression.slice(0, colon);
  const rest = expression.slice(colon + 1);
  if (!INTERACTIVE.has(name)) throw new TemplateError(`Unknown variable: ${name}.`, "unknown-variable");
  if (rest.length === 0) throw new TemplateError(`Malformed ${name}: missing prompt.`, "malformed-variable");
  if (name === "choice") {
    const parts = rest.split("|");
    if (parts.length < 3 || parts.some((p) => p.length === 0)) throw new TemplateError("Malformed choice: choice requires a label and at least two options.", "malformed-choice");
    return { raw: `{{${expression}}}`, expression, name, args: parts, start, end, interactive: true };
  }
  if (rest.includes("|")) throw new TemplateError(`Malformed ${name}: prompts cannot contain |.`, "malformed-variable");
  return { raw: `{{${expression}}}`, expression, name, args: [rest], start, end, interactive: true };
}

export function classifyVariableRisk(variable: string | TemplateVariable): TemplateVariableRisk {
  const name = typeof variable === "string" ? variable.split(":", 1)[0]! : variable.name;
  if (INTERACTIVE.has(name)) return "interactive";
  if (["git_branch", "git_status", "git_diff"].includes(name)) return "repository";
  if (["editor", "diagnostics", "last_user_message", "last_assistant_message", "last_message", "last_code_block", "session_name", "model", "current_file", "current_file_path"].includes(name)) return "sensitive";
  return "low";
}

function defaultValue(name: string, context: TemplateResolutionContext): string {
  if (name === "input") return context.input ?? "";
  if (name === "args") return context.args ?? context.input ?? "";
  if (name === "cwd") return context.cwd ?? context.values?.cwd ?? "[cwd unavailable]";
  if (name === "project") return context.project ?? context.values?.project ?? "[project unavailable]";
  if (name === "date") return new Date().toISOString().slice(0, 10);
  if (name === "datetime") return new Date().toISOString();
  return context.values?.[name] ?? `[${name} unavailable]`;
}

async function resolveVar(v: TemplateVariable, context: TemplateResolutionContext, interactors: TemplateInteractors, preview: boolean): Promise<string> {
  if (!v.interactive) return defaultValue(v.name, context);
  if (preview) return `[interactive: ${v.expression}]`;
  if (v.name === "ask") {
    if (!interactors.input) throw new TemplateError(`Missing input interactor for ${v.raw}.`, "missing-interactor");
    return await interactors.input(v.args![0]!);
  }
  if (v.name === "choice") {
    if (!interactors.select) throw new TemplateError(`Missing select interactor for ${v.raw}.`, "missing-interactor");
    return await interactors.select(v.args![0]!, v.args!.slice(1));
  }
  if (!interactors.confirm) throw new TemplateError(`Missing confirm interactor for ${v.raw}.`, "missing-interactor");
  return (await interactors.confirm(v.args![0]!)) ? "yes" : "no";
}

export function enforceExpansionLimits(parts: Array<{ variable: string; value: string }>, mode: "preview" | "send"): { text: string; truncated: boolean } {
  let total = "";
  let truncated = false;
  for (const part of parts) {
    let value = part.value;
    if (mode === "send") {
      if (value.length > EXPANSION_LIMITS.sendPerVarChars) throw new TemplateError(`${part.variable} exceeds send limit of ${EXPANSION_LIMITS.sendPerVarChars} characters.`, "send-limit");
    } else {
      const lines = value.split("\n");
      if (value.length > EXPANSION_LIMITS.previewPerVarChars || lines.length > EXPANSION_LIMITS.previewPerVarLines) {
        const shownLines = lines.slice(0, EXPANSION_LIMITS.previewPerVarLines).join("\n");
        value = shownLines.slice(0, EXPANSION_LIMITS.previewPerVarChars) + `\n[${part.variable} truncated in preview: ${Math.min(lines.length, EXPANSION_LIMITS.previewPerVarLines)} of ${lines.length} lines shown]`;
        truncated = true;
      }
    }
    total += value;
  }
  const max = mode === "send" ? EXPANSION_LIMITS.sendTotalChars : EXPANSION_LIMITS.previewTotalChars;
  if (total.length > max) {
    if (mode === "send") throw new TemplateError(`Expanded message exceeds send limit of ${max} characters.`, "send-limit");
    total = total.slice(0, max) + "\n[preview truncated: total preview limit reached]";
    truncated = true;
  }
  return { text: total, truncated };
}

export async function resolveTemplate(body: string, context: TemplateResolutionContext = {}, interactors: TemplateInteractors = {}, options: TemplateResolutionOptions = {}): Promise<TemplateResolutionResult> {
  const preview = options.preview === true;
  const variables = findVariables(body);
  const cache = new Map<string, string>();
  const parts: Array<{ variable: string; value: string }> = [];
  let cursor = 0;
  let requiresConfirmation = false;
  const source = body.replaceAll("\\{{", ESC);
  for (const v of variables) {
    parts.push({ variable: "text", value: source.slice(cursor, v.start).replaceAll(ESC, "{{") });
    let value = cache.get(v.expression);
    if (value === undefined) {
      value = await resolveVar(v, context, interactors, preview);
      cache.set(v.expression, value);
    }
    parts.push({ variable: v.name, value });
    if (v.interactive || classifyVariableRisk(v) === "sensitive" || (options.flow === "direct" && classifyVariableRisk(v) !== "low")) requiresConfirmation = true;
    cursor = v.end;
  }
  parts.push({ variable: "text", value: source.slice(cursor).replaceAll(ESC, "{{") });
  const limited = enforceExpansionLimits(parts, preview ? "preview" : "send");
  return { text: limited.text, variables: variables.map((v) => v.expression), truncated: limited.truncated, requiresConfirmation: requiresConfirmation || limited.truncated, errors: [] };
}

export function previewTemplate(body: string, context: TemplateResolutionContext = {}): Promise<TemplateResolutionResult> {
  return resolveTemplate(body, context, {}, { preview: true, flow: "picker" });
}
