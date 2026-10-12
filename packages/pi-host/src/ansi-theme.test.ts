import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { ANSI_THEME } from "./ansi-theme.ts";

const TOKENS: ThemeColor[] = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdQuote",
  "mdHr",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxKeyword",
  "syntaxString",
  "syntaxNumber",
  "syntaxComment",
  "syntaxFunction",
  "syntaxType",
  "bashMode",
  "customMessageLabel",
  "scrollbarTrack",
  "thinkingOff",
  "thinkingHigh",
];

/** Every SGR parameter list in a string. */
const ESC = "\u001b";
const sgrParams = (text: string) =>
  [...text.matchAll(new RegExp(`${ESC}\\[([0-9;]*)m`, "g"))].map((m) => m[1] ?? "");
const ALLOWED = /^(?:30|31|32|33|34|35|36|37|90|39|1|2|3|4|22|23|24)$/;

describe("the ANSI theme extensions get (owner C2)", () => {
  it("renders tokens with the basic SGR colours, dim and the default colour", () => {
    expect(ANSI_THEME.fg("error", "x")).toBe("\u001b[31mx\u001b[39m");
    expect(ANSI_THEME.fg("success", "x")).toBe("\u001b[32mx\u001b[39m");
    expect(ANSI_THEME.fg("accent", "x")).toBe("\u001b[34mx\u001b[39m");
    expect(ANSI_THEME.fg("muted", "x")).toBe("\u001b[2mx\u001b[22m");
    expect(ANSI_THEME.fg("text", "x")).toBe("x");
    expect(ANSI_THEME.bold("x")).toBe("\u001b[1mx\u001b[22m");
  });

  it("emits only codes 30-37, 90, bold, dim, italic and underline for every token and style", () => {
    const rendered = [
      ...TOKENS.map((token) => ANSI_THEME.fg(token, "x")),
      ...TOKENS.map((token) => ANSI_THEME.getFgAnsi(token)),
      ANSI_THEME.bg("selectedBg", "x"),
      ANSI_THEME.getBgAnsi("selectedBg"),
      ANSI_THEME.inverse("x"),
      ANSI_THEME.strikethrough("x"),
      ANSI_THEME.bold("x"),
      ANSI_THEME.italic("x"),
      ANSI_THEME.underline("x"),
      ANSI_THEME.style("x", { fg: "error", bold: true, dim: true, italic: true, underline: true }),
      ANSI_THEME.getThinkingBorderColor("high")("x"),
      ANSI_THEME.getBashModeBorderColor()("x"),
    ].join("");
    const params = sgrParams(rendered);
    expect(params.length).toBeGreaterThan(40);
    for (const code of params) expect(code).toMatch(ALLOWED);
    expect(rendered.replace(new RegExp(`${ESC}\\[[0-9;]*m`, "g"), "")).not.toContain(ESC);
    expect(rendered).not.toMatch(new RegExp(`${ESC}\\[(?:38|48);|${ESC}\\[(?:4[0-7]|10\\d|7|9)m`));
  });
});
