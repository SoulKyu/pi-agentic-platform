import { CommandTooComplex } from "./shell-words.ts";

/** Steps one (pattern, segment form) pair may spend, and one call in all (M5R17). */
export const PAIR_BUDGET = 2_000_000;
export const CALL_BUDGET = 20_000_000;
export interface StepBudget {
  left: number;
}

/**
 * Whole-text glob match: `*` any run, `?` one character, the rest literal. The classic two-pointer walk with one
 * remembered star: at most `pattern.length × text.length` steps, each charged to `budget` (M5R17).
 */
export function globMatch(
  pattern: string,
  text: string,
  options: { ignoreCase: boolean; budget: StepBudget },
): boolean {
  const p = options.ignoreCase ? pattern.toLowerCase() : pattern;
  const t = options.ignoreCase ? text.toLowerCase() : text;
  let pi = 0;
  let ti = 0;
  let star = -1;
  let mark = 0;
  while (ti < t.length) {
    if (--options.budget.left < 0) throw new CommandTooComplex("glob budget spent");
    if (pi < p.length && (p[pi] === "?" || p[pi] === t[ti])) {
      pi++;
      ti++;
    } else if (pi < p.length && p[pi] === "*") {
      star = pi++;
      mark = ti;
    } else if (star !== -1) {
      pi = star + 1;
      ti = ++mark;
    } else return false;
  }
  while (pi < p.length && p[pi] === "*") pi++;
  return pi === p.length;
}
