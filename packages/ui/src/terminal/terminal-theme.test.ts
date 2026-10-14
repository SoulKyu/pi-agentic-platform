import { describe, expect, it } from "vitest";
import { terminalTheme } from "./terminal-theme.ts";

const read = (name: string) => `v:${name}`;
const LITERAL_COLOUR = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|light-dark\(/i;

describe("the terminal theme", () => {
  it("reads the base colours from the tokens", () => {
    const theme = terminalTheme(read);
    expect(theme.background).toBe("v:bg");
    expect(theme.foreground).toBe("v:text");
    expect(theme.cursor).toBe("v:you-fill");
    expect(theme.cursorAccent).toBe("v:bg");
    expect(theme.selectionBackground).toBe("v:surface-2");
  });

  it("maps the 16 ANSI colours by DESIGN 9.2, the bright ones the same", () => {
    const theme = terminalTheme(read);
    const expected = {
      black: "v:text-dim",
      red: "v:err",
      green: "v:ok",
      yellow: "v:you",
      blue: "v:agent",
      magenta: "v:attn",
      cyan: "v:agent",
      white: "v:text",
    };
    for (const [name, value] of Object.entries(expected)) {
      const bright = `bright${name[0]?.toUpperCase()}${name.slice(1)}` as keyof typeof theme;
      expect(theme[name as keyof typeof theme], name).toBe(value);
      expect(theme[bright], bright).toBe(value);
    }
  });

  it("asks the reader only for pap tokens, never a literal colour", () => {
    const asked: string[] = [];
    const theme = terminalTheme((name) => {
      asked.push(name);
      return `v:${name}`;
    });
    expect(new Set(asked)).toEqual(
      new Set(["bg", "text", "you-fill", "surface-2", "text-dim", "err", "ok", "you", "agent", "attn"]),
    );
    for (const value of Object.values(theme)) expect(String(value)).not.toMatch(LITERAL_COLOUR);
  });
});
