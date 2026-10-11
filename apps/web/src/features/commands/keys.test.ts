import { describe, expect, it } from "vitest";
import { chordFromEvent, chordId, keyCandidates, matchesChord, parseChord, type KeyInput } from "./keys.ts";

const ev = (over: Partial<KeyInput>): KeyInput => ({
  key: "k",
  code: "KeyK",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("parseChord", () => {
  it("reads modifiers, aliases and the plus key", () => {
    expect(parseChord("Mod+K")).toEqual({
      mod: true,
      ctrl: false,
      meta: false,
      alt: false,
      shift: false,
      key: "k",
    });
    expect(parseChord("ctrl+alt+esc")?.key).toBe("escape");
    expect(parseChord("mod++")?.key).toBe("+");
    expect(parseChord("alt+shift+right")?.key).toBe("arrowright");
  });
  it("refuses empty, none, two keys, doubled or ambiguous modifiers, unknown names", () => {
    for (const bad of ["", "none", "a+b", "ctrl+ctrl+k", "mod+ctrl+k", "mod+meta+k", "ctrl+", "mod+banana"])
      expect(parseChord(bad), bad).toBeNull();
  });
  it("refuses non-string input from storage or import instead of throwing", () => {
    for (const bad of [null, undefined, 42, {}, ["mod+k"]])
      expect(parseChord(bad as never), String(bad)).toBeNull();
  });
});

describe("matching", () => {
  it("resolves mod to Cmd on Apple platforms and Ctrl elsewhere, with exact modifiers", () => {
    const chord = parseChord("mod+k");
    if (!chord) throw new Error("chord");
    expect(matchesChord(chord, ev({ metaKey: true }), "mac")).toBe(true);
    expect(matchesChord(chord, ev({ ctrlKey: true }), "mac")).toBe(false);
    expect(matchesChord(chord, ev({ ctrlKey: true }), "other")).toBe(true);
    expect(matchesChord(chord, ev({ ctrlKey: true, shiftKey: true }), "other")).toBe(false);
  });

  it("never matches during a composition, Safari's keyCode 229, Process, or AltGr", () => {
    expect(keyCandidates(ev({ isComposing: true }), "other")).toEqual([]);
    expect(keyCandidates(ev({ keyCode: 229 }), "mac")).toEqual([]);
    expect(keyCandidates(ev({ key: "Process" }), "other")).toEqual([]);
    expect(
      keyCandidates(
        ev({
          key: "@",
          code: "Digit0",
          ctrlKey: true,
          altKey: true,
          getModifierState: (n) => n === "AltGraph",
        }),
        "other",
      ),
    ).toEqual([]);
  });

  it("finds Ctrl+K on a Cyrillic layout and Option+W on a Mac through the physical key", () => {
    expect(matchesChord(parseChord("mod+k") as never, ev({ key: "л", ctrlKey: true }), "other")).toBe(true);
    expect(
      matchesChord(parseChord("alt+w") as never, ev({ key: "∑", code: "KeyW", altKey: true }), "mac"),
    ).toBe(true);
  });

  it("matches digits by their physical key (AZERTY Ctrl+Alt+1 on Linux types &)", () => {
    expect(
      matchesChord(
        parseChord("ctrl+alt+1") as never,
        ev({ key: "&", code: "Digit1", ctrlKey: true, altKey: true }),
        "other",
      ),
    ).toBe(true);
  });

  it("does not take a letter's physical key when the layout key is a usable letter (AZERTY A is not Q)", () => {
    expect(
      matchesChord(parseChord("mod+q") as never, ev({ key: "a", code: "KeyQ", ctrlKey: true }), "other"),
    ).toBe(false);
    expect(
      matchesChord(parseChord("mod+a") as never, ev({ key: "a", code: "KeyQ", ctrlKey: true }), "other"),
    ).toBe(true);
  });

  it("lets a shifted symbol match whatever Shift the layout needs, through the layout key only", () => {
    expect(
      matchesChord(parseChord("?") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other"),
    ).toBe(true);
    expect(
      matchesChord(parseChord("?") as never, ev({ key: "?", code: "KeyM", shiftKey: true }), "other"),
    ).toBe(true);
    // A physical "/" must not fire on Shift+/ ("?"): a match through the physical key needs the exact Shift (M3-RT-28).
    expect(
      matchesChord(parseChord("/") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other"),
    ).toBe(false);
    expect(
      matchesChord(parseChord("shift+/") as never, ev({ key: "?", code: "Slash", shiftKey: true }), "other"),
    ).toBe(true);
  });

  it("gives one identity per platform and records chords with mod", () => {
    expect(chordId(parseChord("mod+shift+k") as never, "mac")).toBe("shift+meta+k");
    expect(chordId(parseChord("ctrl+shift+k") as never, "other")).toBe(
      chordId(parseChord("mod+shift+k") as never, "other"),
    );
    expect(chordFromEvent(ev({ key: "P", code: "KeyP", ctrlKey: true, shiftKey: true }), "other")).toBe(
      "mod+shift+p",
    );
    expect(chordFromEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }), "other")).toBeNull();
  });

  it("records digits and punctuation by physical key, letters by layout key (owner R3-7)", () => {
    // AZERTY Ctrl+1 types "&": the binding is stored as mod+1, so it means the same key on a QWERTY device.
    expect(chordFromEvent(ev({ key: "&", code: "Digit1", ctrlKey: true }), "other")).toBe("mod+1");
    expect(chordFromEvent(ev({ key: "?", code: "Slash", shiftKey: true }), "other")).toBe("shift+/");
    // AZERTY's "?" sits on the KeyM position: a letter code, so the layout character is kept.
    expect(chordFromEvent(ev({ key: "?", code: "KeyM", shiftKey: true }), "other")).toBe("shift+?");
    expect(chordFromEvent(ev({ key: "a", code: "KeyQ", ctrlKey: true }), "other")).toBe("mod+a");
  });
});

describe("parseChord on hostile names", () => {
  it("does not resolve names through Object.prototype", () => {
    for (const bad of ["constructor+k", "mod+__proto__", "toString", "ctrl+hasOwnProperty"])
      expect(parseChord(bad), bad).toBeNull();
  });
});

describe("fix round 1", () => {
  const EVENTS: Array<[Partial<KeyInput>, "mac" | "other"]> = [
    [{ key: "k", code: "KeyK", ctrlKey: true, metaKey: true }, "other"],
    [{ key: "k", code: "KeyK", ctrlKey: true, metaKey: true }, "mac"],
    [{ key: "k", code: "KeyK", ctrlKey: true }, "mac"],
    [{ key: "k", code: "KeyK", metaKey: true }, "other"],
    [{ key: "+", code: "Equal", shiftKey: true }, "other"],
    [{ key: "+", code: "Equal", ctrlKey: true, shiftKey: true }, "other"],
    [{ key: "+", code: "Equal", metaKey: true }, "mac"],
    [{ key: "+", code: "NumpadAdd", metaKey: true }, "mac"],
    [{ key: "ArrowRight", code: "ArrowRight", altKey: true, shiftKey: true }, "other"],
    [{ key: " ", code: "Space", ctrlKey: true }, "other"],
    [{ key: "F5", code: "F5" }, "other"],
    [{ key: "&", code: "Digit1", ctrlKey: true }, "other"],
    [{ key: "Escape", code: "Escape" }, "other"],
  ];

  it("every recorded chord parses back and matches the event that made it", () => {
    for (const [over, platform] of EVENTS) {
      const event = ev(over);
      const text = chordFromEvent(event, platform);
      const chord = text === null ? null : parseChord(text);
      expect(chord, `${String(text)} for ${JSON.stringify(over)}`).not.toBeNull();
      expect(matchesChord(chord as never, event, platform), String(text)).toBe(true);
    }
    expect(chordFromEvent(ev({ key: "k", ctrlKey: true, metaKey: true }), "other")).toBe("ctrl+meta+k");
    // The numpad plus has no punctuation code, so the layout key "+" is recorded: the parser's "mod++" form.
    expect(chordFromEvent(ev({ key: "+", code: "NumpadAdd", metaKey: true }), "mac")).toBe("mod++");
    expect(chordFromEvent(ev({ key: "+", code: "NumpadAdd" }), "mac")).toBe("+");
  });

  it("returns null for a key the parser would refuse", () => {
    expect(chordFromEvent(ev({ key: "ContextMenu", code: "ContextMenu" }), "other")).toBeNull();
  });

  it("parses a bare plus and caps the input length", () => {
    expect(parseChord("+")?.key).toBe("+");
    // Whitespace padding would trim to a valid chord: only the length cap refuses the 65-character form.
    expect(parseChord(`${" ".repeat(60)}mod+k`)).toBeNull();
    expect(parseChord(`${" ".repeat(59)}mod+k`)?.key).toBe("k");
  });

  it("takes the physical key only when the layout key is unusable or a digit/punctuation character", () => {
    expect(chordFromEvent(ev({ key: "m", code: "Semicolon", ctrlKey: true }), "other")).toBe("mod+m");
    expect(
      matchesChord(parseChord("mod+;") as never, ev({ key: "m", code: "Semicolon", ctrlKey: true }), "other"),
    ).toBe(false);
    expect(chordFromEvent(ev({ key: "End", code: "Numpad1", ctrlKey: true }), "other")).toBe("mod+end");
    expect(
      matchesChord(parseChord("mod+1") as never, ev({ key: "End", code: "Numpad1", ctrlKey: true }), "other"),
    ).toBe(false);
    expect(chordFromEvent(ev({ key: "&", code: "Digit1", ctrlKey: true }), "other")).toBe("mod+1");
    expect(keyCandidates(ev({ key: "Dead", code: "KeyE" }), "other")).toEqual(["e"]);
  });

  it("never throws on an event without a key (Chrome autofill)", () => {
    const bare = {
      code: "KeyA",
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
    } as unknown as KeyInput;
    expect(keyCandidates(bare, "other")).toEqual([]);
    expect(chordFromEvent(bare, "other")).toBeNull();
    expect(matchesChord(parseChord("mod+a") as never, bare, "other")).toBe(false);
  });
});
