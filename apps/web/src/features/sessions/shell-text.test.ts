import { describe, expect, it } from "vitest";
import { shellText } from "./shell-text.ts";

const ESC = String.fromCharCode(27);
const C1 = String.fromCodePoint(0x9b);

describe("shellText", () => {
  it("ESC, CR, BEL, DEL and C1 are removed, so ESC[201~ followed by a line cannot end the paste", () => {
    const hostile = `echo a${ESC}[201~\rrm -rf x${C1}${String.fromCharCode(7)}${String.fromCharCode(127)}`;
    const result = shellText(hostile, "bash");
    expect(result).toEqual({ text: "echo a[201~rm -rf x" });
    const text = "text" in result ? result.text : "";
    for (const bad of [ESC, "\r", C1, String.fromCharCode(7), String.fromCharCode(127)])
      expect(text.includes(bad)).toBe(false);
  });

  it("leading and trailing blank lines and a final new line are dropped", () => {
    expect(shellText("\n\n  \nls -la  \n\n\n", "bash")).toEqual({ text: "ls -la" });
    expect(shellText("a\n\nb\n", "sh")).toEqual({ text: "a\n\nb" });
  });

  it("console keeps prompt lines only, without $ or #; a console block without prompts is kept", () => {
    expect(shellText("$ ls\nfile-a\nfile-b\n  # whoami\nroot\n", "console")).toEqual({ text: "ls\nwhoami" });
    expect(shellText("ls\nfile-a", "console")).toEqual({ text: "ls\nfile-a" });
    expect(shellText("$ ls\nfile-a", "bash")).toEqual({ text: "$ ls\nfile-a" });
  });

  it("16 KiB + 1 byte is too_long; blank is empty", () => {
    expect(shellText("a".repeat(16 * 1024), "bash")).toEqual({ text: "a".repeat(16 * 1024) });
    expect(shellText("a".repeat(16 * 1024 + 1), "bash")).toEqual({ refused: "too_long" });
    expect(shellText("é".repeat(8 * 1024 + 1), "bash")).toEqual({ refused: "too_long" });
    expect(shellText("  \n\n ", "bash")).toEqual({ refused: "empty" });
    expect(shellText("$ \n", "console")).toEqual({ refused: "empty" });
  });
});
