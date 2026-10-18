import { describe, expect, it } from "vitest";
import { parseChord } from "./keys.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "./defaults.ts";

const bound = (key: string): string[] =>
  DEFAULT_KEYBINDINGS.filter((rule) => rule.key === key).map((rule) => rule.command);

describe("the default shortcuts kept from pi-web (spec C 7.3, parity P20)", () => {
  it("binds Esc, Ctrl+Alt+N, Alt+Up and Down and Ctrl+Alt+1 to 9 to a known command", () => {
    expect(bound("escape")).toEqual(["session.stop"]);
    expect(bound("ctrl+alt+n")).toEqual(["session.new"]);
    expect(bound("alt+arrowup")).toEqual(["agent.prevUnread"]);
    expect(bound("alt+arrowdown")).toEqual(["agent.nextUnread"]);
    for (let n = 1; n <= 9; n++) expect(bound(`ctrl+alt+${n}`)).toEqual([`agent.goto.${n}`]);
    for (const rule of DEFAULT_KEYBINDINGS) expect(KNOWN_COMMANDS.has(rule.command)).toBe(true);
  });

  it("writes every default chord in a form the parser reads", () => {
    for (const rule of DEFAULT_KEYBINDINGS) expect(parseChord(rule.key), rule.key).not.toBeNull();
  });
});
