import type { CustomTheme } from "@pap/contracts";
import { THEME_TOKENS } from "@pap/ui";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.ts";
import { deriveTheme, roleChecks, tokenVars } from "./derive.ts";

// DESIGN.md §13.1's example.
const example: CustomTheme = {
  id: "my-theme",
  name: "My theme",
  base: "night",
  roles: {
    bg: "#0E1626",
    surface: "#132033",
    agent: "#38BDF8",
    you: "#FB923C",
    attn: "#EC4899",
    ok: "#34D399",
    err: "#F87171",
    text: "#E6EDF7",
  },
};
const paper: CustomTheme = {
  ...example,
  id: "paper",
  base: "day",
  roles: { ...example.roles, bg: "#FFFDF8", surface: "#FFFFFF", text: "#1C1917", agent: "#A78BFA" },
};
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;

describe("custom themes (DESIGN.md §13.2)", () => {
  it("derives every token, and only hex colours reach the token map", () => {
    const tokens = deriveTheme(example);
    expect(Object.keys(tokens).sort()).toEqual([...THEME_TOKENS].sort());
    for (const [name, value] of Object.entries(tokens)) expect(value, name).toMatch(HEX);
    expect(tokenVars(tokens)["--bg"]).toBe("#0e1626");
  });

  it("makes tints 10 % and lines 40 % (55 % for attention) of the fill", () => {
    const tokens = deriveTheme(example);
    expect([tokens["you-tint"], tokens["you-line"], tokens["attn-tint"], tokens["attn-line"]]).toEqual([
      "#fb923c1a",
      "#fb923c66",
      "#ec48991a",
      "#ec48998c",
    ]);
  });

  it("darkens day text tones until they reach 4.5:1 on bg, and keeps the fill", () => {
    const tokens = deriveTheme(paper);
    expect(tokens["agent-fill"]).toBe("#a78bfa");
    expect(contrastRatio(tokens.agent, tokens.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(tokens["text-muted"], tokens.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it("picks the ink with the better contrast on each fill", () => {
    const tokens = deriveTheme(example);
    expect(contrastRatio(tokens["you-ink"], tokens["you-fill"])).toBeGreaterThanOrEqual(4.5);
  });

  it("derives ADR 0012's tokens: 3:1 for the focus ring and control borders, 4.5:1 for the approval title on its card", () => {
    for (const theme of [example, paper]) {
      const t = deriveTheme(theme);
      for (const ground of [t.bg, t.surface]) {
        expect(
          contrastRatio(t["focus-ring"], ground),
          `${theme.id} focus on ${ground}`,
        ).toBeGreaterThanOrEqual(3);
        expect(
          contrastRatio(t["control-border"], ground),
          `${theme.id} control border on ${ground}`,
        ).toBeGreaterThanOrEqual(3);
      }
      expect(
        contrastRatio(t["attn-title"], t["attn-tint"], t.surface),
        `${theme.id} approval title`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("reports a role below AA so the editor can ask before saving", () => {
    const dim = { ...example, roles: { ...example.roles, text: "#1A2333" } };
    const checks = roleChecks(dim);
    expect(checks.find((c) => c.role === "text")?.passes).toBe(false);
    expect(roleChecks(example).every((c) => c.passes)).toBe(true);
  });
});
