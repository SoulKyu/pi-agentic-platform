import { describe, expect, it } from "vitest";
import { cutUnits, stripHidden } from "./untrusted-text.ts";

describe("stripHidden", () => {
  it("keeps tab and new line and removes the other controls", () => {
    expect(stripHidden("a\tb\nc\u0000d\u001be")).toBe("a\tb\ncde");
  });

  it("removes bidi controls, zero-width characters and line and paragraph separators", () => {
    expect(stripHidden("a\u202eb\u200bc\u2028d\u2029e\ufeff")).toBe("abcde");
  });

  it("keeps a joiner between two pictographs, so an emoji sequence survives", () => {
    const family = "\u{1F468}\u200d\u{1F469}\u200d\u{1F467}";
    expect(stripHidden(family)).toBe(family);
    const heart = "\u{1F469}\u200d\u2764\ufe0f\u200d\u{1F468}";
    expect(stripHidden(heart)).toBe(heart);
    const skin = "\u{1F469}\u{1F3FD}\u200d\u{1F4BB}";
    expect(stripHidden(skin)).toBe(skin);
  });

  it("removes a joiner that is alone, at an edge or between other characters", () => {
    expect(stripHidden("a\u200db")).toBe("ab");
    expect(stripHidden("\u200d\u{1F468}")).toBe("\u{1F468}");
    expect(stripHidden("\u{1F468}\u200d")).toBe("\u{1F468}");
    expect(stripHidden("\u{1F468}\u200da")).toBe("\u{1F468}a");
    expect(stripHidden("a\u200d\u{1F468}")).toBe("a\u{1F468}");
    expect(stripHidden("\u{1F468}\u200d\u200d\u{1F469}")).toBe("\u{1F468}\u{1F469}");
  });

  it("still removes every other format character next to a pictograph", () => {
    expect(stripHidden("\u{1F468}\u200b\u{1F469}\u202e")).toBe("\u{1F468}\u{1F469}");
  });
});

describe("cutUnits", () => {
  it("leaves a text that fits", () => {
    expect(cutUnits("abc", 3)).toBe("abc");
  });

  it("counts the marker inside the limit", () => {
    expect(cutUnits("abcdef", 4)).toBe("abc…");
  });

  it("never ends on half of a surrogate pair", () => {
    expect(cutUnits("ab\u{1F600}cd", 4)).toBe("ab…");
  });
});
