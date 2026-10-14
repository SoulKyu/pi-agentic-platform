import { describe, expect, it } from "vitest";
import {
  insertAt,
  insertMention,
  isShowable,
  mentionAt,
  mentionPath,
  mentionText,
  relativePath,
} from "./mention.vm.ts";

describe("mentionAt", () => {
  it("finds the query of an @ before the caret", () => {
    expect(mentionAt("see @sr", 7)).toEqual({ start: 4, query: "sr" });
    expect(mentionAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionAt("@src/a", 6)).toEqual({ start: 0, query: "src/a" });
  });

  it("is null when the @ is inside a word, or a blank ended the query", () => {
    expect(mentionAt("a@b", 3)).toBeNull();
    expect(mentionAt("see @sr x", 9)).toBeNull();
    expect(mentionAt("see @sr\nx", 9)).toBeNull();
    expect(mentionAt("plain", 5)).toBeNull();
  });

  it("reads only up to the caret", () => {
    expect(mentionAt("see @srcX", 7)).toEqual({ start: 4, query: "sr" });
    expect(mentionAt("/skill:x @sr", 12)).toEqual({ start: 9, query: "sr" });
  });
});

describe("insertMention", () => {
  it("replaces the query, adds a space and puts the caret after it", () => {
    expect(insertMention("see @sr", { start: 4, query: "sr" }, "@src/a.ts")).toEqual({
      text: "see @src/a.ts ",
      caret: 14,
    });
    expect(insertMention("a @s tail", { start: 2, query: "s" }, "@x.ts")).toEqual({
      text: "a @x.ts  tail",
      caret: 8,
    });
  });
});

describe("mentionText and paths", () => {
  it("quotes a path that holds a blank", () => {
    expect(mentionText("src/a b.ts")).toBe('@"src/a b.ts"');
    expect(mentionText("src/a.ts")).toBe("@src/a.ts");
  });

  it("is relative to the session folder, with ../ above it", () => {
    expect(mentionPath("lib/x.ts", "/p", "/p/app")).toBe("../lib/x.ts");
    expect(mentionPath("app/y.ts", "/p", "/p/app")).toBe("y.ts");
    expect(mentionPath("a.ts", "/p", "/p")).toBe("a.ts");
    expect(relativePath("/p/app", "/p/app/src/z.ts")).toBe("src/z.ts");
    expect(relativePath("/p/app/deep", "/p/lib/x.ts")).toBe("../../lib/x.ts");
    expect(relativePath("/p/app", "/q/x.ts")).toBe("../../q/x.ts");
  });
});

describe("insertAt and isShowable", () => {
  it("adds a blank before the mention only when the caret follows a character", () => {
    expect(insertAt("see ", 4, "@a.ts")).toEqual({ text: "see @a.ts ", caret: 10 });
    expect(insertAt("see", 3, "@a.ts")).toEqual({ text: "see @a.ts ", caret: 10 });
    expect(insertAt("ab", 1, "@a.ts")).toEqual({ text: "a @a.ts b", caret: 8 });
    expect(insertAt("", 0, "@a.ts")).toEqual({ text: "@a.ts ", caret: 6 });
  });

  it("refuses a path with a line break or an invisible character", () => {
    expect(isShowable("src/a.ts")).toBe(true);
    expect(isShowable("src/a\n.ts")).toBe(false);
    expect(isShowable("src/a\u202Eb.ts")).toBe(false);
    expect(isShowable("src/a\u200Bb.ts")).toBe(false);
  });
});
