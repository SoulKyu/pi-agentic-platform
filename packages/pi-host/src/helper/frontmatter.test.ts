import { describe, expect, it } from "vitest";
import { setFrontmatterFlag } from "./frontmatter.ts";

const KEY = "disable-model-invocation";

describe("setFrontmatterFlag", () => {
  for (const [label, eol, bom] of [
    ["LF", "\n", ""],
    ["CRLF", "\r\n", ""],
    ["LF with a BOM", "\n", "\uFEFF"],
    ["CRLF with a BOM", "\r\n", "\uFEFF"],
  ] as const) {
    it(`adds then removes the line and returns the file byte for byte (${label})`, () => {
      const original = `${bom}---${eol}name: a${eol}description: d${eol}---${eol}# Body${eol}text${eol}`;
      const on = setFrontmatterFlag(original, KEY, true);
      expect(on).toBe(
        `${bom}---${eol}name: a${eol}description: d${eol}${KEY}: true${eol}---${eol}# Body${eol}text${eol}`,
      );
      expect(setFrontmatterFlag(on as string, KEY, false)).toBe(original);
    });
  }

  it("replaces an existing false line instead of duplicating it", () => {
    const text = `---\nname: a\n${KEY}: false\ndescription: d\n---\nbody\n`;
    expect(setFrontmatterFlag(text, KEY, true)).toBe(
      `---\nname: a\ndescription: d\n${KEY}: true\n---\nbody\n`,
    );
  });

  it("gives an empty frontmatter the line", () => {
    expect(setFrontmatterFlag("---\n\n---\nbody\n", KEY, true)).toBe(`---\n${KEY}: true\n---\nbody\n`);
  });

  it("refuses a file without frontmatter or with an unclosed one", () => {
    expect(setFrontmatterFlag("# no frontmatter\n", KEY, true)).toBeNull();
    expect(setFrontmatterFlag("---\nname: a\nbody never closed\n", KEY, true)).toBeNull();
  });

  it("refuses a value of the key continued on indented lines, for both directions", () => {
    const folded = `---\nname: a\n${KEY}: >\n  true\n---\nbody\n`;
    expect(setFrontmatterFlag(folded, KEY, true)).toBeNull();
    expect(setFrontmatterFlag(folded, KEY, false)).toBeNull();
  });

  it("leaves a body that contains --- alone", () => {
    const text = `---\nname: a\n---\nbody\n---\nmore\n---\n`;
    expect(setFrontmatterFlag(text, KEY, true)).toBe(
      `---\nname: a\n${KEY}: true\n---\nbody\n---\nmore\n---\n`,
    );
  });

  it("does not take a key that only starts with the same letters", () => {
    const text = `---\n${KEY}-x: 1\n---\n`;
    expect(setFrontmatterFlag(text, KEY, false)).toBe(text);
  });
});
