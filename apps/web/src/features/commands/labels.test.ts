import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import {
  ariaKeyShortcuts,
  chordJoiner,
  chordTokens,
  detectPlatform,
  keyNames,
  type KeyNames,
} from "./labels.ts";

const names: KeyNames = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Meta",
  escape: "Esc",
  enter: "Enter",
  space: "Space",
  tab: "Tab",
  backspace: "Backspace",
  delete: "Del",
  up: "Up",
  down: "Down",
  left: "Left",
  right: "Right",
  home: "Home",
  end: "End",
  pageup: "PgUp",
  pagedown: "PgDn",
};

describe("labels (pw lib/shortcut-label.ts)", () => {
  it("detects Apple platforms, iPad included", () => {
    expect(detectPlatform({ platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "iPhone" })).toBe("mac");
    expect(detectPlatform({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X) Version/16.4 Safari" })).toBe(
      "mac",
    );
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
  });
  it("uses ⌃⌥⇧⌘ glyphs in that order on Apple platforms and names elsewhere", () => {
    const chord = parseChord("mod+alt+shift+n") as never;
    expect(chordTokens(chord, "mac", names)).toEqual(["⌥", "⇧", "⌘", "N"]);
    expect(chordTokens(chord, "other", names)).toEqual(["Ctrl", "Alt", "Shift", "N"]);
    expect([chordJoiner("mac"), chordJoiner("other")]).toEqual(["", "+"]);
    expect(chordTokens(parseChord("alt+shift+right") as never, "mac", names)).toEqual(["⌥", "⇧", "→"]);
  });
  it("builds the key names from the catalog of the current language", () => {
    const names = keyNames((key) => `<${key}>`);
    expect([names.ctrl, names.escape, names.pagedown]).toEqual([
      "<commands.key.ctrl>",
      "<commands.key.escape>",
      "<commands.key.pagedown>",
    ]);
  });

  it("writes aria-keyshortcuts in the ARIA form", () => {
    expect(ariaKeyShortcuts(parseChord("mod+k") as never, "mac")).toBe("Meta+K");
    expect(ariaKeyShortcuts(parseChord("mod+k") as never, "other")).toBe("Control+K");
  });
});

describe("fix round 1", () => {
  it("writes UI Events key names in aria-keyshortcuts", () => {
    const aria = (text: string) => ariaKeyShortcuts(parseChord(text) as never, "other");
    expect(aria("alt+up")).toBe("Alt+ArrowUp");
    expect(aria("ctrl+pageup")).toBe("Control+PageUp");
    expect(aria("ctrl+pagedown")).toBe("Control+PageDown");
    expect(aria("ctrl+space")).toBe("Control+Space");
    expect(aria("f5")).toBe("F5");
    expect(aria("mod++")).toBe("Control++");
    expect(aria("esc")).toBe("Escape");
  });
  it("uses the control glyph on Apple platforms", () => {
    expect(chordTokens(parseChord("ctrl+k") as never, "mac", names)).toEqual(["⌃", "K"]);
  });
});
