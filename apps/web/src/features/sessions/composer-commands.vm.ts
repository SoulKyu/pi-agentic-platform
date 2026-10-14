import type { SessionCommand } from "@pap/contracts";

export type ListedCommand = SessionCommand;

/** A `/` at the start of the text or a `$` at the start of a word, with the characters typed after it. */
export interface Trigger {
  readonly char: "/" | "$";
  readonly query: string;
  readonly start: number;
}

export interface Picked {
  readonly text: string;
  readonly caret: number;
}

export const MAX_ROWS = 50;
const MAX_DESCRIPTION = 200;
const BLANK = /\s/;
const SKILL_PREFIX = /^\/skill:(\S+) /u;
/** Names come from extensions and files: one with a blank, a control or an invisible character would break the line or hide what it says. */
const SAFE_NAME = /^[^\s\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u;

/** The trigger the caret is in: no blank between its sigil and the caret; `/` only at the very start (M7R119). */
export function activeTrigger(text: string, caret: number): Trigger | null {
  for (let index = caret - 1; index >= 0; index--) {
    const char = text.charAt(index);
    if (BLANK.test(char)) return null;
    if (char === "/" && index === 0) return { char, query: text.slice(1, caret), start: 0 };
    if (char === "$" && (index === 0 || BLANK.test(text.charAt(index - 1))))
      return { char, query: text.slice(index + 1, caret), start: index };
  }
  return null;
}

/** The skill the text starts with (`/skill:<name> `), if any. */
export function skillPrefix(text: string): string | null {
  return SKILL_PREFIX.exec(text)?.[1] ?? null;
}

export function stripSkillPrefix(text: string): string {
  return text.replace(SKILL_PREFIX, "");
}

const withoutToken = (text: string, trigger: Trigger): { head: string; tail: string } => ({
  head: text.slice(0, trigger.start),
  tail: text.slice(trigger.start + 1 + trigger.query.length),
});

/** `/<name> ` in place of the typed token; the caret lands after it. */
export function completeCommand(text: string, trigger: Trigger, name: string): Picked {
  const { head, tail } = withoutToken(text, trigger);
  const completed = `${head}/${name} `;
  return { text: `${completed}${tail}`, caret: completed.length };
}

/** `/skill:<name> ` first in the text (one skill per message: a skill already there is replaced), the token taken out. */
export function pickSkill(text: string, trigger: Trigger, skill: string): Picked {
  const { head, tail } = withoutToken(text, trigger);
  const prefix = `/skill:${skill} `;
  const rest = head.endsWith(" ") && tail.startsWith(" ") ? `${head}${tail.slice(1)}` : `${head}${tail}`;
  return { text: `${prefix}${stripSkillPrefix(rest)}`, caret: prefix.length };
}

export interface CommandRow {
  readonly key: string;
  /** What the row shows: `/name`, or `$skill` after a `$`. */
  readonly label: string;
  readonly name: string;
  /** Set when picking the row chooses a skill: its name without Pi's `skill:` prefix. */
  readonly skill: string | null;
  readonly description: string | null;
  readonly builtinMcp: boolean;
}

const SKILL_NAME = "skill:";

/** The rows for a trigger: names that contain the query, prefix matches first, at most 50 (M7R121). */
export function rowsFor(commands: readonly ListedCommand[], trigger: Trigger): CommandRow[] {
  const query = trigger.query.toLowerCase();
  const matching = commands
    .filter((command) => SAFE_NAME.test(command.name))
    .map((command) => {
      const skill =
        command.source === "skill" && command.name.startsWith(SKILL_NAME)
          ? command.name.slice(SKILL_NAME.length)
          : null;
      return { command, skill };
    })
    .filter(({ skill }) => trigger.char === "/" || skill !== null)
    .map(({ command, skill }) => {
      const shown = trigger.char === "$" ? (skill ?? command.name) : command.name;
      return { command, skill, shown, rank: rankOf(shown.toLowerCase(), query) };
    })
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank);
  // Two extensions may register the same name: the index keeps the key unique.
  return matching.slice(0, MAX_ROWS).map(({ command, skill, shown }, index) => ({
    key: `${command.source}:${command.name}:${index}`,
    label: `${trigger.char}${shown}`,
    name: command.name,
    skill,
    description: command.description === null ? null : command.description.slice(0, MAX_DESCRIPTION),
    builtinMcp: command.builtinMcp,
  }));
}

/** 0 for a prefix match, 1 for another match, -1 for none. The sort is stable, so Pi's order holds within a rank. */
function rankOf(name: string, query: string): number {
  if (name.startsWith(query)) return 0;
  return name.includes(query) ? 1 : -1;
}
