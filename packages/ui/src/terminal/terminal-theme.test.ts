import { describe, expect, it } from "vitest";
import { PRESET_TOKENS } from "../presets.ts";
import type { ThemeName } from "../token-names.ts";
import { mixHex, withAlpha } from "./ansi-palette.ts";
import { terminalTheme } from "./terminal-theme.ts";

const read = (name: string) => `v:${name}`;
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|light-dark\(/i;
const THEMES: readonly ThemeName[] = ["night", "day", "hc"];
const BASES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;
const bright = (name: string) => `bright${name[0]?.toUpperCase()}${name.slice(1)}`;
const readerOf = (theme: ThemeName) => (name: string) => {
  const value = (PRESET_TOKENS[theme] as Record<string, string>)[name];
  if (value === undefined) throw new Error(`no token ${name}`);
  return value;
};

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
const asRecord = (theme: object) => theme as Record<string, string>;

describe("the terminal theme", () => {
  it("reads the base colours from the tokens", () => {
    const theme = terminalTheme(read);
    expect(theme.background).toBe("v:bg");
    expect(theme.foreground).toBe("v:text");
    expect(theme.cursor).toBe("v:you-fill");
    expect(theme.cursorAccent).toBe("v:bg");
  });

  it("maps the base colours by D8 and brightWhite to text", () => {
    const theme = asRecord(terminalTheme(readerOf("night")));
    const n = PRESET_TOKENS.night;
    expect(theme.black).toBe(n["text-muted"]);
    expect(theme.red).toBe(n.err);
    expect(theme.green).toBe(n.ok);
    expect(theme.yellow).toBe(n.you);
    expect(theme.blue).toBe(n.agent);
    expect(theme.magenta).toBe(n.attn);
    expect(theme.white).toBe(mixHex(n.text, n["text-muted"], 0.35));
    expect(theme.brightWhite).toBe(n.text);
    expect(theme.cyan).toBe(mixHex(n.agent, n.ok, 0.5));
  });

  it("the 16 colours are 16 distinct values in Night, Day and High contrast", () => {
    for (const name of THEMES) {
      const theme = asRecord(terminalTheme(readerOf(name)));
      const values = BASES.flatMap((base) => [theme[base], theme[bright(base)]]);
      expect(values).toHaveLength(16);
      expect(new Set(values).size, name).toBe(16);
    }
  });

  it("cyan differs from blue", () => {
    for (const name of THEMES) {
      const theme = asRecord(terminalTheme(readerOf(name)));
      expect(theme.cyan, name).not.toBe(theme.blue);
    }
  });

  it("each bright colour is its base mixed 35 % toward text", () => {
    for (const name of THEMES) {
      const theme = asRecord(terminalTheme(readerOf(name)));
      const text = PRESET_TOKENS[name].text;
      for (const base of BASES.filter((b) => b !== "white")) {
        expect(theme[bright(base)], `${name} ${base}`).toBe(mixHex(theme[base] as string, text, 0.35));
      }
    }
  });

  it("the selection is the agent at 35 % alpha and text on it reaches 7:1 in every theme", () => {
    for (const name of THEMES) {
      const tokens = PRESET_TOKENS[name];
      const theme = asRecord(terminalTheme(readerOf(name)));
      expect(theme.selectionBackground, name).toBe(withAlpha(tokens.agent, 0x59));
      const blended = mixHex(tokens.bg, tokens.agent, 0x59 / 255);
      expect(ratio(tokens.text, blended), name).toBeGreaterThanOrEqual(7);
    }
  });

  it("white reaches 4.5:1 on bg in every theme", () => {
    for (const name of THEMES) {
      const theme = asRecord(terminalTheme(readerOf(name)));
      expect(ratio(theme.white as string, PRESET_TOKENS[name].bg), name).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("asks the reader only for pap tokens, never a literal colour", () => {
    const asked: string[] = [];
    const theme = terminalTheme((name) => {
      asked.push(name);
      return PRESET_TOKENS.night[name as keyof typeof PRESET_TOKENS.night];
    });
    expect(new Set(asked)).toEqual(
      new Set(["bg", "text", "you-fill", "text-muted", "err", "ok", "you", "agent", "attn"]),
    );
    for (const name of asked) expect(name).not.toMatch(LITERAL_COLOUR);
    expect(Object.keys(theme).length).toBeGreaterThan(16);
  });
});
