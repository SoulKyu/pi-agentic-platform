import { describe, expect, it } from "vitest";
import { HIGHLIGHT_SPEC, THEME_SPEC } from "./theme.ts";

const TOKEN = /^var\(--[a-z0-9-]+\)/;
const LITERAL_COLOUR =
  /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|hwb\(|oklch\(|oklab\(|light-dark\(|\b(?:white|black|red|blue|green)\b/i;
const COLOUR_PROPERTIES =
  /^(?:color|background|backgroundColor|borderColor|border(?:Left|Right|Top|Bottom)Color|outlineColor|caretColor|textDecorationColor|fill|stroke)$/;

const values = (spec: Record<string, Record<string, string>>): [string, string, string][] =>
  Object.entries(spec).flatMap(([selector, rules]) =>
    Object.entries(rules).map(([property, value]): [string, string, string] => [selector, property, value]),
  );

describe("the editor theme", () => {
  const theme = values(THEME_SPEC);
  const highlight = HIGHLIGHT_SPEC.flatMap((entry) =>
    Object.entries(entry.style).map(([property, value]): [string, string, string] => [
      entry.name,
      property,
      value,
    ]),
  );

  it("has rules to check", () => {
    expect(theme.length).toBeGreaterThan(30);
    expect(highlight.length).toBeGreaterThan(8);
  });

  it("writes every colour as a pap token, never as a literal", () => {
    for (const [selector, property, value] of [...theme, ...highlight]) {
      expect(value, `${selector} ${property}`).not.toMatch(LITERAL_COLOUR);
      if (COLOUR_PROPERTIES.test(property)) expect(value, `${selector} ${property}`).toMatch(TOKEN);
    }
  });

  it("colours the merge view's lines with the diff tokens", () => {
    const flat = JSON.stringify(THEME_SPEC);
    expect(flat).toContain("var(--diff-add)");
    expect(flat).toContain("var(--diff-del)");
  });

  // CodeMirror's base theme paints the search panel in light greys (a gradient on the buttons, white inputs): under night
  // and high contrast it would leak. Each of its controls is overridden with tokens, so a theme switch re-colours them.
  it("overrides the base theme's panel, buttons, inputs and search panel with tokens", () => {
    const rules = (selector: string) => THEME_SPEC[selector] ?? {};
    expect(rules(".cm-panel")).toMatchObject({ backgroundColor: "var(--surface)", color: "var(--text)" });
    expect(rules(".cm-button")).toMatchObject({
      backgroundImage: "none",
      backgroundColor: "var(--surface-2)",
      borderColor: "var(--border-strong)",
      color: "var(--text)",
    });
    expect(rules(".cm-textfield")).toMatchObject({
      backgroundColor: "var(--bg)",
      borderColor: "var(--control-border)",
      color: "var(--text)",
    });
    expect(rules(".cm-panel.cm-search label")).toMatchObject({ color: "var(--text)" });
    expect(rules(".cm-panel.cm-search [name=close]")).toMatchObject({ color: "var(--text-muted)" });
    expect(rules(".cm-button:active")).toMatchObject({ backgroundImage: "none" });
    expect(rules(".cm-textfield:focus, .cm-button:focus-visible")).toMatchObject({
      outlineColor: "var(--focus-ring)",
    });
  });

  it("never blinks: no animation on the cursor", () => {
    expect(JSON.stringify(THEME_SPEC)).not.toMatch(/animation/i);
  });
});
