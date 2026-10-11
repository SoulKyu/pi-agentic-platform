import { describe, expect, it } from "vitest";
import type { KeyInput } from "./keys.ts";
import { parseChord } from "./keys.ts";
import { CONTEXT_KEYS, DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "./defaults.ts";
import { conflictsOf, isReserved, matchingCommands, mergeWithDefaults } from "./resolve.ts";

const known = new Set(["palette.toggle", "drawer.tree.toggle", "shortcuts.help", "tab.close"]);
const defaults = [
  { key: "mod+k", command: "palette.toggle" },
  { key: "mod+b", command: "drawer.tree.toggle", when: "!dialogOpen" },
  { key: "?", command: "shortcuts.help", when: "!editableFocus && !dialogOpen" },
];
const ev = (over: Partial<KeyInput>): KeyInput => ({
  key: "k",
  code: "KeyK",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("merge (T3 mergeWithDefaultKeybindings)", () => {
  it("replaces the defaults of every command a user rule names, and `none` unbinds", () => {
    const { rules } = mergeWithDefaults(
      defaults,
      [
        { key: "mod+shift+p", command: "palette.toggle" },
        { key: "none", command: "drawer.tree.toggle" },
      ],
      known,
    );
    expect(rules.map((r) => `${r.source}:${r.command}`)).toEqual([
      "default:shortcuts.help",
      "user:palette.toggle",
    ]);
  });
  it("drops invalid user entries one by one and says which", () => {
    const { rules, issues } = mergeWithDefaults(
      defaults,
      [
        { key: "mod+banana", command: "palette.toggle" },
        { key: "mod+j", command: "nope.nothing" },
        { key: "mod+j", command: "tab.close", when: "a &&" },
        { key: "alt+w", command: "tab.close" },
      ],
      known,
    );
    expect(issues).toEqual([
      { index: 0, problem: "key" },
      { index: 1, problem: "command" },
      { index: 2, problem: "when" },
    ]);
    expect(rules.filter((r) => r.source === "user").map((r) => r.command)).toEqual(["tab.close"]);
  });
});

describe("matchingCommands", () => {
  const { rules } = mergeWithDefaults(defaults, [], known);
  it("puts the last matching rule first and honours when clauses", () => {
    expect(
      matchingCommands(ev({ ctrlKey: true, key: "b", code: "KeyB" }), rules, { dialogOpen: false }, "other"),
    ).toEqual(["drawer.tree.toggle"]);
    expect(
      matchingCommands(ev({ ctrlKey: true, key: "b", code: "KeyB" }), rules, { dialogOpen: true }, "other"),
    ).toEqual([]);
  });
  it("never fires inside a terminal-input panel unless the clause names panelFocus (agreement 7)", () => {
    const loose = mergeWithDefaults(
      [],
      [
        { key: "mod+k", command: "palette.toggle" },
        { key: "mod+j", command: "tab.close", when: "panelFocus" },
      ],
      known,
    ).rules;
    expect(matchingCommands(ev({ ctrlKey: true }), loose, { panelFocus: true }, "other")).toEqual([]);
    expect(
      matchingCommands(ev({ ctrlKey: true, key: "j", code: "KeyJ" }), loose, { panelFocus: true }, "other"),
    ).toEqual(["tab.close"]);
  });

  it("never fires a bare printable key in a text field unless its clause names editableFocus", () => {
    const loose = mergeWithDefaults([], [{ key: "?", command: "shortcuts.help" }], known).rules;
    const question = ev({ key: "?", code: "Slash", shiftKey: true });
    expect(matchingCommands(question, loose, { editableFocus: true }, "other")).toEqual([]);
    expect(matchingCommands(question, loose, { editableFocus: false }, "other")).toEqual(["shortcuts.help"]);
  });
});

describe("the default bindings (agreement 7, M3-RT-30)", () => {
  const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
  it("keep every chord out of a terminal-input panel, and Escape out of open menus", () => {
    for (const rule of DEFAULT_KEYBINDINGS) expect(rule.when ?? "", rule.command).toContain("!panelFocus");
    const escape = (context: Record<string, boolean>) =>
      matchingCommands(ev({ key: "Escape", code: "Escape" }), rules, context, "other");
    expect(escape({ sessionFocus: true })).toEqual(["session.stop"]);
    expect(escape({ sessionFocus: true, overlayOpen: true })).toEqual([]);
    expect(escape({ sessionFocus: true, panelFocus: true })).toEqual([]);
  });
  it("let mod+b close the tree drawer, which is itself a modal", () => {
    const modB = (context: Record<string, boolean>) =>
      matchingCommands(ev({ ctrlKey: true, key: "b", code: "KeyB" }), rules, context, "other");
    expect(modB({ dialogOpen: true, treeOpen: true })).toEqual(["drawer.tree.toggle"]);
    expect(modB({ dialogOpen: true })).toEqual([]);
  });
  it("only read context keys the shell provides", () => {
    const used = new Set(DEFAULT_KEYBINDINGS.flatMap((rule) => rule.when?.match(/[A-Za-z]+/g) ?? []));
    expect([...used].filter((name) => !(CONTEXT_KEYS as readonly string[]).includes(name))).toEqual([]);
  });
  it("have no conflict among themselves and no reserved chord on either platform", () => {
    expect(conflictsOf(rules, "other").size).toBe(0);
    expect(conflictsOf(rules, "mac").size).toBe(0);
    for (const rule of rules) {
      expect(isReserved(rule.chord, "other"), rule.command).toBe(false);
      expect(isReserved(rule.chord, "mac"), rule.command).toBe(false);
    }
  });
});

describe("conflicts and reserved chords", () => {
  it("flags two rules on one chord when either has no clause or both clauses are equal", () => {
    const { rules } = mergeWithDefaults(defaults, [{ key: "ctrl+k", command: "tab.close" }], known);
    expect(conflictsOf(rules, "other").get(rules.length - 1)).toEqual(["palette.toggle"]);
    expect(conflictsOf(rules, "mac").size).toBe(0);
  });
  it("flags browser-reserved chords", () => {
    expect(isReserved(parseChord("mod+w") as never, "other")).toBe(true);
    expect(isReserved(parseChord("mod+t") as never, "mac")).toBe(true);
    expect(isReserved(parseChord("ctrl+tab") as never, "mac")).toBe(true);
    expect(isReserved(parseChord("mod+3") as never, "other")).toBe(true);
    expect(isReserved(parseChord("alt+3") as never, "other")).toBe(true);
    expect(isReserved(parseChord("mod+k") as never, "other")).toBe(false);
  });
  it("stays fast on a full stored list of 256 rules on one chord", () => {
    const user = Array.from({ length: 256 }, (_, i) => ({
      key: "mod+j",
      command: i % 2 ? "tab.close" : "palette.toggle",
    }));
    const { rules } = mergeWithDefaults([], user, known);
    expect(rules).toHaveLength(256);
    expect(conflictsOf(rules, "other").size).toBe(256);
  });
});
