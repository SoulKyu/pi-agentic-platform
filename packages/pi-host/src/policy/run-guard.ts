import type { GuardLimits, GuardRule } from "@pap/contracts/pi-host";
import type { GuardResult, Stages } from "./pipeline.ts";

/** What the model is told when the guard stops a call (M5R34): no count, no input. */
export const GUARD_MODEL_REASON = "pap-policy stopped this call: the run guard tripped.";
/** Above every limit a rule can hold (10 000 calls at most), so a counter never wraps or grows without end. */
export const MAX_COUNT = 100_000;

export const GUARD_TITLES: Readonly<Record<GuardRule, (limit: number) => string>> = {
  "identical-calls": (n) => `The agent repeated the same call ${n} times in a row. Allow it once more?`,
  "tool-calls": (n) => `The agent has made ${n} tool calls in this run. Allow one more?`,
  turns: (n) => `The agent has taken ${n} turns in this run. Allow this call?`,
};

const LIMIT_OF: Readonly<Record<GuardRule, keyof GuardLimits>> = {
  "identical-calls": "identicalCalls",
  "tool-calls": "toolCalls",
  turns: "turns",
};
export const guardTitle = (rule: GuardRule, limits: GuardLimits): string =>
  GUARD_TITLES[rule](limits[LIMIT_OF[rule]]);

/**
 * "Identical" means the exact canonical input: a small change of argument starts a new streak, and the call and turn caps
 * bound the run anyway. When two rules trip at once only the first by priority (identical, calls, turns) is reported,
 * and "Allow once" releases that one.
 */
/** The reason a trip writes in the trail: the rule and its limit, never a word of the call. */
const REASONS: Readonly<Record<GuardRule, (limit: number) => string>> = {
  "identical-calls": (n) => `the same call ${n} times in a row`,
  "tool-calls": (n) => `more than ${n} tool calls in this run`,
  turns: (n) => `more than ${n} turns in this run`,
};

export interface RunGuard {
  /** A new run: every counter restarts (Pi's `agent_start`). */
  onRunStart(): void;
  /** An assistant message ended. */
  onTurn(): void;
  /** Pure: what the guard says of a call that has not been counted yet. */
  check(key: string, topLevel: boolean, limits: GuardLimits): GuardResult;
  /** Counts a call that was evaluated (blocked ones too); nested calls count for nothing. */
  commit(key: string, topLevel: boolean): void;
  /** A person allowed the call once: that rule's counter starts again. */
  release(rule: GuardRule): void;
  counts(): { calls: number; turns: number; streak: number };
}

export function createRunGuard(): RunGuard {
  let calls = 0;
  let turns = 0;
  let streak = 0;
  let last: string | null = null;
  const up = (n: number): number => Math.min(n + 1, MAX_COUNT);
  return {
    onRunStart() {
      calls = 0;
      turns = 0;
      streak = 0;
      last = null;
    },
    onTurn() {
      turns = up(turns);
    },
    check(key, topLevel, limits) {
      if (!topLevel) return { outcome: "pass" };
      const rule: GuardRule | null =
        (last === key ? streak : 0) + 1 >= limits.identicalCalls
          ? "identical-calls"
          : calls + 1 > limits.toolCalls
            ? "tool-calls"
            : turns > limits.turns
              ? "turns"
              : null;
      return rule === null
        ? { outcome: "pass" }
        : { outcome: "trip", rule, reason: REASONS[rule](limits[LIMIT_OF[rule]]) };
    },
    commit(key, topLevel) {
      if (!topLevel) return;
      calls = up(calls);
      streak = last === key ? up(streak) : 1;
      last = key;
    },
    release(rule) {
      if (rule === "identical-calls") {
        streak = 0;
        last = null;
      } else if (rule === "tool-calls") calls = 0;
      else turns = 0;
    },
    counts: () => ({ calls, turns, streak }),
  };
}

/** The stage-04 slot and the counting `commit` of one guard. The release comes after the count: the allowed call opens the new window. */
export function guardStages(guard: RunGuard): Pick<Stages, "guard" | "commit"> {
  return {
    guard: (call) => guard.check(call.key, call.event.parentToolCallId === undefined, call.rules.guard),
    commit: (call, _decision, released) => {
      guard.commit(call.key, call.event.parentToolCallId === undefined);
      if (released) guard.release(released);
    },
  };
}
