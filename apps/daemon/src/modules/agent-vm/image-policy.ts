import { createHash } from "node:crypto";
import { AGENT_VM_PROTOCOL } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";

/** Spec §6: posted once in the thread of an agent that keeps running on its old image while the new one builds. */
export const BUILD_NOTICE = "Une nouvelle image est en préparation ; cet agent tourne sur l'ancienne.";
/** After a failed weekly upgrade the next try waits this long (an `apt upgrade` is minutes of root's BuildKit). */
const RETRY_AFTER_MS = 3_600_000;
const DAY_MS = 86_400_000;

export interface RunningImage {
  readonly tag: string;
  /** The pap protocol the image's guest speaks (`AGENT_VM_PROTOCOL` when it was built). */
  readonly protocol: number;
}

export type ImageDecision =
  | { readonly action: "use"; readonly tag: string }
  /** `use: null` is a start with no image to fall back on: it waits for the build, with no notice. */
  | {
      readonly action: "build-then-use";
      readonly build: string;
      readonly use: string | null;
      readonly notice: string | null;
    }
  | {
      readonly action: "refuse";
      readonly reason: "protocol";
      readonly running: number;
      readonly expected: number;
    };

export interface DecideInput {
  readonly agentId: string;
  /** The tag the agent's inputs give today (the profile tag, or the agent layer's). */
  readonly wanted: string;
  readonly running: RunningImage | null;
  /** The tags pap-vmd holds (`image.list`). */
  readonly built: ReadonlySet<string>;
}

/** The ISO 8601 week of an instant (UTC): `2026-W43`. The ISO year differs from the calendar year around New Year. */
export function isoWeek(ms: number): string {
  const day = new Date(ms);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const weekday = (day.getUTCDay() + 6) % 7; // Monday 0
  const thursday = new Date(midnight + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week = Math.floor((thursday.getTime() - Date.UTC(year, 0, 1)) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export interface ImagePolicy {
  /** Spec §6: `use`, `build-then-use` (the notice once per agent and wanted image) or `refuse` on a protocol change. */
  decide(input: DecideInput): ImageDecision;
  /** The ISO week to rebuild the base for, handed out once; null when this week is done, a build runs or a retry waits. */
  claimBaseUpgrade(): string | null;
  /** The caller's build ended: a success records the week, a failure allows a retry after an hour. */
  baseUpgradeFinished(week: string, ok: boolean): void;
  /** The last ISO week a base rebuild succeeded in (to persist, and to pass back as `lastBaseWeek` at boot). */
  lastBaseWeek(): string | null;
  /**
   * The base tag as the profile tag hashes it. A weekly rebuild keeps the base tag (its inputs did not change), so the
   * week of the last successful rebuild joins it: the profile and agent tags change and rebuild on the new base.
   */
  baseKey(baseTag: string): string;
}

export function createImagePolicy(options: { clock: Clock; lastBaseWeek?: string | null }): ImagePolicy {
  const { clock } = options;
  let upgradedWeek = options.lastBaseWeek ?? null;
  let inFlight = false;
  let retryAt = 0;
  const noticed = new Map<string, string>();
  return {
    decide({ agentId, wanted, running, built }) {
      if (built.has(wanted)) return { action: "use", tag: wanted };
      if (running === null) return { action: "build-then-use", build: wanted, use: null, notice: null };
      if (running.protocol !== AGENT_VM_PROTOCOL)
        return {
          action: "refuse",
          reason: "protocol",
          running: running.protocol,
          expected: AGENT_VM_PROTOCOL,
        };
      if (running.tag === wanted) return { action: "use", tag: wanted };
      const first = noticed.get(agentId) !== wanted;
      noticed.set(agentId, wanted);
      return {
        action: "build-then-use",
        build: wanted,
        use: running.tag,
        notice: first ? BUILD_NOTICE : null,
      };
    },
    claimBaseUpgrade() {
      const week = isoWeek(clock.now());
      if (inFlight || week === upgradedWeek || clock.now() < retryAt) return null;
      inFlight = true;
      return week;
    },
    baseUpgradeFinished(week, ok) {
      inFlight = false;
      if (ok) upgradedWeek = week;
      else retryAt = clock.now() + RETRY_AFTER_MS;
    },
    lastBaseWeek: () => upgradedWeek,
    baseKey(baseTag) {
      if (upgradedWeek === null) return baseTag;
      const hex = createHash("sha256").update(`pap-base-key-1\0${baseTag}\0${upgradedWeek}`).digest("hex");
      return `pap-agent-base-${hex}`;
    },
  };
}
