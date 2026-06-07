export interface Macro {
  name: string;
  description?: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface MacroFile {
  version: 1;
  macros: Macro[];
  [key: string]: unknown;
}

export type CommandResult =
  | { ok: true; message?: string }
  | { ok: false; error: string; code?: string };

export type TemplateVariableRisk = "low" | "repository" | "sensitive" | "interactive";

export interface TemplateResolutionContext {
  input?: string;
  args?: string;
  cwd?: string;
  project?: string;
  values?: Record<string, string>;
}

export interface TemplateVariable {
  raw: string;
  expression: string;
  name: string;
  args?: string[];
  start: number;
  end: number;
  interactive: boolean;
}

export interface TemplateInteractors {
  input?: (question: string) => Promise<string> | string;
  select?: (label: string, options: string[]) => Promise<string> | string;
  confirm?: (question: string) => Promise<boolean> | boolean;
}

export interface TemplateResolutionOptions {
  flow?: "direct" | "picker";
  preview?: boolean;
}

export interface TemplateResolutionResult {
  text: string;
  variables: string[];
  truncated: boolean;
  requiresConfirmation: boolean;
  errors: string[];
}

export type PickerAction =
  | { type: "send"; name: string }
  | { type: "create"; name?: string }
  | { type: "edit"; name: string }
  | { type: "delete"; name: string }
  | { type: "duplicate"; source: string; target?: string }
  | { type: "preview"; name: string }
  | { type: "filter"; query: string }
  | { type: "close" };
