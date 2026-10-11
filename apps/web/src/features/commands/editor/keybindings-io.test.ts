import { describe, expect, it, vi } from "vitest";
import {
  exportKeybindingsFile,
  MAX_KEYBINDINGS_FILE_BYTES,
  parseKeybindingsFile,
  readKeybindingsFile,
  recordedChordProblem,
} from "./keybindings-io.ts";

const parse = (text: string) => parseKeybindingsFile(text, "other");

describe("keybindings files", () => {
  it("keeps valid rules, reports each bad entry by index, and warns on reserved chords", () => {
    const text = JSON.stringify([
      { key: "mod+shift+p", command: "palette.toggle" },
      { key: "mod+k", command: "rm -rf" },
      { key: "mod+banana", command: "palette.toggle" },
      { key: "mod+j", command: "tab.close", when: "a &&" },
      { key: "mod+w", command: "tab.close" },
      "nope",
      { key: "mod+q", command: "nope.nothing" },
    ]);
    const parsed = parse(text);
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.rules.map((r) => r.key)).toEqual(["mod+shift+p", "mod+banana", "mod+j", "mod+w"]);
    expect(parsed.issues).toEqual([
      { index: 1, problem: "shape" },
      { index: 2, problem: "key" },
      { index: 3, problem: "when" },
      { index: 4, problem: "reserved" },
      { index: 5, problem: "shape" },
      { index: 6, problem: "command" },
    ]);
    expect(parsed.omittedIssues).toBe(0);
  });

  it("refuses what it cannot read", () => {
    expect(parse("x".repeat(MAX_KEYBINDINGS_FILE_BYTES + 1))).toEqual({ ok: false, error: "too_large" });
    // 40 000 characters but 80 000 bytes: the size is the byte length.
    expect(parse("é".repeat(40_000))).toEqual({ ok: false, error: "too_large" });
    expect(parse("{oops")).toEqual({ ok: false, error: "not_json" });
    expect(parse('{"key":"a"}')).toEqual({ ok: false, error: "not_array" });
    expect(
      parse(JSON.stringify(Array.from({ length: 257 }, () => ({ key: "mod+k", command: "palette.toggle" })))),
    ).toEqual({ ok: false, error: "too_many" });
  });

  it("caps the issues it lists and says how many it left out", () => {
    const parsed = parse(
      JSON.stringify(Array.from({ length: 30 }, () => ({ key: "mod+banana", command: "palette.toggle" }))),
    );
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.rules).toHaveLength(30);
    expect(parsed.issues).toHaveLength(20);
    expect(parsed.issues[19]).toEqual({ index: 19, problem: "key" });
    expect(parsed.omittedIssues).toBe(10);
  });

  it("is not polluted by __proto__ keys in an entry", () => {
    const parsed = parse('[{"key":"alt+p","command":"palette.toggle","__proto__":{"polluted":true}}]');
    if (!parsed.ok) throw new Error("parse");
    expect(parsed.rules).toEqual([{ key: "alt+p", command: "palette.toggle" }]);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });

  it("exports pretty JSON that reads back the same", () => {
    const rules = [{ key: "alt+p", command: "palette.toggle", when: "!dialogOpen" }];
    expect(exportKeybindingsFile(rules)).toBe(`${JSON.stringify(rules, null, 2)}\n`);
    const back = parse(exportKeybindingsFile(rules));
    expect(back.ok && back.rules).toEqual(rules);
  });

  it("checks a file's size before reading its text", async () => {
    const text = vi.fn(async () => "[]");
    const big = { size: MAX_KEYBINDINGS_FILE_BYTES + 1, text } as unknown as File;
    expect(await readKeybindingsFile(big, "other")).toEqual({ ok: false, error: "too_large" });
    expect(text).not.toHaveBeenCalled();
    const fine = { size: 2, text } as unknown as File;
    expect(await readKeybindingsFile(fine, "other")).toMatchObject({ ok: true, rules: [] });
    const unreadable = {
      size: 2,
      text: async () => {
        throw new Error("denied");
      },
    } as unknown as File;
    expect(await readKeybindingsFile(unreadable, "other")).toEqual({ ok: false, error: "not_json" });
  });
});

describe("recordedChordProblem", () => {
  it("needs a modifier, except for the help key and the function keys", () => {
    expect(recordedChordProblem("q", "tab.close", "other")).toBe("no_modifier");
    expect(recordedChordProblem("shift+q", "tab.close", "other")).toBe("no_modifier");
    expect(recordedChordProblem("q", "shortcuts.help", "other")).toBeNull();
    expect(recordedChordProblem("f5", "tab.close", "other")).toBeNull();
    expect(recordedChordProblem("mod+q", "tab.close", "other")).toBeNull();
    expect(recordedChordProblem("alt+q", "tab.close", "other")).toBeNull();
  });
  it("refuses the chords the browser keeps, per platform", () => {
    expect(recordedChordProblem("mod+w", "tab.close", "other")).toBe("reserved");
    expect(recordedChordProblem("mod+w", "tab.close", "mac")).toBe("reserved");
    expect(recordedChordProblem("ctrl+w", "tab.close", "mac")).toBeNull();
    expect(recordedChordProblem("mod+banana", "tab.close", "other")).toBe("unusable");
  });
});
