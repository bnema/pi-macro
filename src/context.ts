import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { TemplateResolutionContext } from "./types.js";

const execFileAsync = promisify(execFile);
const UNAVAILABLE = {
  current_file: "[current_file unavailable: Pi API not exposed]",
  current_file_path: "[current_file_path unavailable: Pi API not exposed]",
  diagnostics: "[diagnostics unavailable: Pi API not exposed]",
};

type PiLikeContext = Record<string, unknown> & {
  cwd?: string;
  ui?: { getEditorText?: () => Promise<string> | string };
  sessionManager?: { getEntries?: () => Promise<unknown[]> | unknown[] };
  model?: unknown;
};

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["--no-pager", ...args], {
      cwd,
      timeout: 2_000,
      env: { ...process.env, GIT_PAGER: "cat", GIT_EXTERNAL_DIFF: "true" },
      shell: false,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    const message = (error as Error).message || "not a repository";
    return `[git unavailable: ${message.includes("not a git") || message.includes("not a repository") ? "not a repository" : "command failed"}]`;
  }
}

function entryText(entry: unknown): { role: string; text: string } | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const role = String(record.role ?? record.type ?? "");
  const content = record.content ?? record.text ?? record.message;
  if (typeof content === "string") return { role, text: content };
  if (content && typeof content === "object" && typeof (content as Record<string, unknown>).text === "string") return { role, text: String((content as Record<string, unknown>).text) };
  return undefined;
}

function latest(entries: Array<{ role: string; text: string }>, role?: string): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i]!;
    if (!role || entry.role === role) return entry.text;
  }
  return role ? `[${role} message unavailable]` : "[last message unavailable]";
}

function lastCodeBlock(entries: Array<{ text: string }>): string {
  for (let i = entries.length - 1; i >= 0; i--) {
    const matches = [...entries[i]!.text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)];
    if (matches.length) return matches[matches.length - 1]![1]!.trimEnd();
  }
  return "[last_code_block unavailable: no fenced code block found]";
}

function modelName(model: unknown): string {
  if (!model) return "[model unavailable]";
  if (typeof model === "string") return model;
  if (typeof model === "object") {
    const r = model as Record<string, unknown>;
    return String(r.name ?? r.id ?? r.model ?? "[model unavailable]");
  }
  return String(model);
}

function sessionName(ctx: PiLikeContext): string {
  for (const key of ["sessionName", "name", "title"]) {
    const value = ctx[key];
    if (typeof value === "string" && value) return value;
  }
  return "[session_name unavailable]";
}

export async function collectTemplateContext(input = "", ctx: PiLikeContext = {}): Promise<TemplateResolutionContext> {
  const cwd = ctx.cwd ?? process.cwd();
  const values: Record<string, string> = { ...UNAVAILABLE };
  values.cwd = cwd;
  values.project = path.basename(cwd);
  const [gitBranch, gitStatus, gitDiff] = await Promise.all([
    git(cwd, ["branch", "--show-current"]),
    git(cwd, ["status", "--short"]),
    git(cwd, ["diff", "--no-ext-diff"]),
  ]);
  values.git_branch = gitBranch;
  values.git_status = gitStatus;
  values.git_diff = gitDiff;
  try { values.editor = ctx.ui?.getEditorText ? await ctx.ui.getEditorText() : "[editor unavailable]"; } catch { values.editor = "[editor unavailable]"; }
  let entries: Array<{ role: string; text: string }> = [];
  try { entries = ((ctx.sessionManager?.getEntries ? await ctx.sessionManager.getEntries() : []) as unknown[]).map(entryText).filter((e): e is { role: string; text: string } => Boolean(e)); } catch { entries = []; }
  values.last_user_message = latest(entries, "user");
  values.last_assistant_message = latest(entries, "assistant");
  values.last_message = latest(entries);
  values.last_code_block = lastCodeBlock(entries);
  values.session_name = sessionName(ctx);
  values.model = modelName(ctx.model);
  return { input, args: input, cwd, project: values.project, values };
}
