import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

const occurrences = (declaration: string) => css.toLowerCase().split(declaration.toLowerCase()).length - 1;

describe("E1 tokens", () => {
  it("defines every themed variable for night, system-light and day", () => {
    const names = [...css.matchAll(/var\(--pap-([a-z-]+)\)/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const name of new Set(names)) expect(css.split(`--pap-${name}:`).length - 1, name).toBe(3);
  });

  it("keeps the decision 11 role colours", () => {
    for (const hex of [
      "#110f18",
      "#a78bfa",
      "#fb923c",
      "#ec4899",
      "#faf9f6",
      "#6d28d9",
      "#c2410c",
      "#be185d",
    ])
      expect(css.toLowerCase()).toContain(hex);
  });

  it("follows DESIGN.md for the panel surface and the ink on the you fill", () => {
    expect(occurrences("--pap-panel: #1a1724;")).toBe(1);
    expect(occurrences("--pap-panel: #ffffff;")).toBe(2);
    expect(occurrences("--pap-on-fill: #1b0d00;")).toBe(3);
  });

  it("keeps the focus fill orange in every mode", () => {
    expect(occurrences("--pap-human-fill: #fb923c;")).toBe(3);
  });

  it("defines the you message box and the attention card tones", () => {
    for (const declaration of [
      "--pap-human-tint: #fb923c1a;",
      "--pap-human-line: #fb923c66;",
      "--pap-human-text: #fed7aa;",
      "--pap-human-tint: #fff4ea;",
      "--pap-human-line: #fdba74;",
      "--pap-human-text: #431407;",
      "--pap-attention-tint: #ec48991a;",
      "--pap-attention-line: #ec48998c;",
      "--pap-attention-tint: #fdf1f6;",
      "--pap-attention-line: #f9a8d4;",
    ])
      expect(css.toLowerCase(), declaration).toContain(declaration);
  });

  it("sizes the HUD label at 10.5 px with 0.12em tracking", () => {
    expect(css).toContain("--text-label: 0.65625rem;");
    expect(css).toContain("--tracking-label: 0.12em;");
  });

  it("loads nothing from the network (fonts are self-hosted)", () => {
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
  });
});
