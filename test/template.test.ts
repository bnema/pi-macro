import { describe, expect, it, vi } from "vitest";
import { collectTemplateContext } from "../src/context.js";
import { enforceExpansionLimits, findVariables, previewTemplate, resolveTemplate } from "../src/template.js";
import type { TemplateResolutionContext } from "../src/types.js";

const baseContext: TemplateResolutionContext = {
  input: "hello world",
  args: "hello world",
  cwd: "/tmp/project",
  project: "project",
  values: {
    git_diff: "diff --git\n".repeat(350),
    editor: "editor text",
    last_user_message: "user said",
  },
};

describe("template variables", () => {
  it("finds approved variables and resolves input/args", async () => {
    expect(findVariables("A {{input}} B {{args}}").map((v) => v.raw)).toEqual(["{{input}}", "{{args}}"]);
    await expect(resolveTemplate("A {{input}} B {{args}}", baseContext)).resolves.toMatchObject({ text: "A hello world B hello world" });
  });

  it("resolves repeated variables consistently", async () => {
    const result = await resolveTemplate("{{input}}/{{input}}", baseContext);
    expect(result.text).toBe("hello world/hello world");
  });

  it("blocks unknown, case-mismatched, whitespace, and malformed variables", () => {
    expect(() => findVariables("{{nope}}")).toThrow(/Unknown variable: nope/);
    expect(() => findVariables("{{Input}}")).toThrow(/Unknown variable: Input/);
    expect(() => findVariables("{{ input }}")).toThrow(/Whitespace inside variable braces is invalid/);
    expect(() => findVariables("{{input")).toThrow(/Malformed variable/);
  });

  it("renders escaped variable syntax literally", async () => {
    const result = await resolveTemplate("literal \\{{input}} real {{input}}", baseContext);
    expect(result.text).toBe("literal {{input}} real hello world");
  });

  it("rejects malformed choices clearly", () => {
    expect(() => findVariables("{{choice:pick|yes}}")).toThrow(/choice requires a label and at least two options/);
    expect(() => findVariables("{{choice:bad}}label|a|b}}")).toThrow(/Malformed choice|Malformed variable/);
  });

  it("collects interactive variables once through interactors", async () => {
    const input = vi.fn().mockResolvedValue("answer");
    const select = vi.fn().mockResolvedValue("two");
    const confirm = vi.fn().mockResolvedValue(true);
    const result = await resolveTemplate("{{ask:q}} {{ask:q}} {{choice:pick|one|two}} {{confirm:sure?}}", baseContext, { input, select, confirm });
    expect(result.text).toBe("answer answer two yes");
    expect(input).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledWith("pick", ["one", "two"]);
    expect(confirm).toHaveBeenCalledWith("sure?");
  });

  it("previews interactive placeholders and discloses truncation", async () => {
    const result = await previewTemplate("{{ask:q}}\n{{git_diff}}", baseContext);
    expect(result.text).toContain("[interactive: ask:q]");
    expect(result.text).toContain("[git_diff truncated in preview:");
    expect(result.truncated).toBe(true);
    expect(result.requiresConfirmation).toBe(true);
  });

  it("blocks send hard limits", () => {
    expect(() => enforceExpansionLimits([{ variable: "input", value: "x".repeat(60_001) }], "send")).toThrow(/input exceeds send limit/);
    expect(() => enforceExpansionLimits([{ variable: "a", value: "x".repeat(60_000) }, { variable: "b", value: "x".repeat(60_000) }, { variable: "c", value: "x" }], "send")).toThrow(/Expanded message exceeds send limit/);
  });

  it("requires confirmation for sensitive variables in direct flows", async () => {
    await expect(resolveTemplate("{{editor}}", baseContext, {}, { flow: "direct" })).resolves.toMatchObject({ requiresConfirmation: true });
  });
});

describe("collectTemplateContext", () => {
  it("collects args, cwd, editor, messages, model, session metadata, and unavailable markers", async () => {
    const ctx = {
      cwd: "/tmp/project",
      ui: { getEditorText: vi.fn().mockResolvedValue("draft") },
      sessionManager: { getEntries: vi.fn().mockResolvedValue([{ role: "user", content: "hi" }, { role: "assistant", content: "```ts\ncode\n```" }]) },
      model: { name: "test-model" },
      sessionName: "session",
    };
    const result = await collectTemplateContext("arg text", ctx);
    expect(result.input).toBe("arg text");
    expect(result.cwd).toBe("/tmp/project");
    expect(result.project).toBe("project");
    expect(result.values?.editor).toBe("draft");
    expect(result.values?.last_user_message).toBe("hi");
    expect(result.values?.last_code_block).toBe("code");
    expect(result.values?.model).toBe("test-model");
    expect(result.values?.session_name).toBe("session");
    expect(result.values?.current_file).toMatch(/unavailable/);
    expect(result.values?.diagnostics).toMatch(/unavailable/);
  });
});
