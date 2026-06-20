import { describe, expect, it } from "vitest";
import { renderMacroRow, visibleLength } from "../src/renderer.js";

const macro = {
  name: "hello",
  tag: "quality",
  body: "This is a long macro body that should appear on one line and be truncated with an ellipsis when needed.\nSecond line is collapsed.",
  createdAt: "a",
  updatedAt: "a",
};

describe("renderMacroRow", () => {
  it("renders name and body as responsive columns", () => {
    const row = renderMacroRow(macro, false, 80);

    expect(visibleLength(row)).toBe(80);
    expect(row).toContain("hello");
    expect(row).toContain("[quality]");
    expect(row).toContain("This is a long macro body");
  });

  it("omits empty tag brackets", () => {
    const row = renderMacroRow({ ...macro, tag: "" }, false, 80);

    expect(row).not.toContain("[]");
  });

  it("uses more available width for the body column on wide rows", () => {
    const narrow = renderMacroRow(macro, false, 50);
    const wide = renderMacroRow(macro, false, 120);

    expect(visibleLength(narrow)).toBe(50);
    expect(visibleLength(wide)).toBe(120);
    expect(wide.length).toBeGreaterThan(narrow.length);
    expect(narrow).toContain("…");
  });

  it("collapses multiline bodies into a single white/default-text row preview", () => {
    const row = renderMacroRow(macro, false, 120);

    expect(row).not.toContain("\n");
    expect(row).not.toContain("\x1b[2mThis is a long macro body");
    expect(row).toContain("This is a long macro body");
  });
});
