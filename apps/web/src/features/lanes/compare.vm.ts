import type { FanoutView, LaneView, ModelPick, ResultOf } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";
import type { MessageKey } from "../../i18n/index.ts";
import { escapeHidden } from "../../lib/escape-hidden.ts";

type Column = ResultOf<"lanes.compare">["columns"][number];

export interface TestsChip {
  readonly tone: ChipTone;
  readonly key: MessageKey;
  /** The exit code a failed run ended with. */
  readonly code?: number;
}

/** Board 10 §2 and M9R96: one chip per test state; `interrupted` asks for attention like a failure. */
export function testsChip(tests: LaneView["tests"]): TestsChip {
  switch (tests.state) {
    case "passed":
      return { tone: "ok", key: "compare.tests.passed" };
    case "failed":
      return tests.exitCode === null
        ? { tone: "att", key: "compare.tests.failedNoCode" }
        : { tone: "att", key: "compare.tests.failed", code: tests.exitCode };
    case "running":
      return { tone: "run", key: "compare.tests.running" };
    case "queued":
      return { tone: "mut", key: "compare.tests.queued" };
    case "unapproved":
      return { tone: "mut", key: "compare.tests.unapproved" };
    case "interrupted":
      return { tone: "att", key: "compare.tests.interrupted" };
    case "none":
      return { tone: "mut", key: "compare.tests.none" };
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `6m40`; under a minute `42s`. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes === 0 ? `${seconds}s` : `${minutes}m${pad(seconds % 60)}`;
}

export const formatCost = (usd: number | null): string => (usd === null ? "—" : `$${usd.toFixed(2)}`);

/**
 * "Run tests" is offered where no test run happened by itself (an issue's lane runs external code, so nothing auto-runs
 * after it; owner m9q6), or where one was cut short. A queued, running or unapproved run is left alone.
 */
export function canRunTests(lane: LaneView): boolean {
  if (lane.state !== "active") return false;
  const { state } = lane.tests;
  if (state === "none" || state === "interrupted") return true;
  if (state === "queued" || state === "running" || state === "unapproved") return false;
  return lane.source.kind === "issue" || lane.createdBy === "token";
}

export interface ColumnModel {
  readonly laneId: string;
  readonly letter: string;
  /** The model id, or null for Pi's default. */
  readonly model: string | null;
  readonly branch: string;
  readonly chip: TestsChip;
  readonly diff: string | null;
  readonly files: string | null;
  /** `null` while the lane runs (the column says so) or when nothing is known. */
  readonly duration: string | null;
  readonly running: boolean;
  readonly cost: string | null;
  readonly summary: string | null;
  /** Changed or untracked files in the worktree (`facts.dirty`); null when not read yet. */
  readonly dirty: number | null;
  readonly runTests: boolean;
  readonly winner: boolean;
}

const letterOf = (lane: LaneView, index: number): string =>
  String.fromCharCode(65 + (lane.fanoutSlot ?? index));

/**
 * One column per live lane of the group, in the group's order. A lane already archived has no column; the figures come
 * from `lanes.compare` and stay empty (not zero) until the daemon has them. Text from the lane is escaped for display.
 */
export function columnModels(
  fanout: FanoutView,
  lanes: ReadonlyMap<string, LaneView>,
  columns: readonly Column[],
  winner: string | null,
): ColumnModel[] {
  const models: ColumnModel[] = [];
  fanout.laneIds.forEach((laneId, index) => {
    const lane = lanes.get(laneId);
    if (lane === undefined) return;
    const column = columns.find((one) => one.laneId === laneId);
    const additions = column?.additions ?? null;
    const deletions = column?.deletions ?? null;
    const durationMs = column?.durationMs ?? null;
    models.push({
      laneId,
      letter: letterOf(lane, index),
      model: lane.model?.modelId ?? null,
      branch: escapeHidden(lane.branch),
      chip: testsChip(lane.tests),
      diff: additions === null || deletions === null ? null : `+${additions} −${deletions}`,
      files: column?.files == null ? null : String(column.files),
      duration: durationMs === null ? null : formatDuration(durationMs),
      running: durationMs === null && lane.firstRunEndedAt === null,
      cost: column?.costUsd == null ? null : formatCost(column.costUsd),
      summary: column?.summary == null ? null : escapeHidden(column.summary),
      dirty: lane.facts?.dirty ?? null,
      runTests: canRunTests(lane),
      winner: winner === laneId,
    });
  });
  return models;
}

/** The lanes "Close losers" archives: every column but the picked winner; none before a pick. */
export const losersOf = (models: readonly ColumnModel[]): ColumnModel[] =>
  models.some((model) => model.winner) ? models.filter((model) => !model.winner) : [];

export interface RunAgainPrefill {
  readonly projectRoot: string;
  /** The issue link of an issue fan-out, else the prompt. */
  readonly text: string;
  readonly models: ReadonlyArray<ModelPick | null>;
}

/** What the new lane dialog opens with: the group's lanes in slot order give the models, the first gives the source. */
export function runAgainPrefill(
  fanout: FanoutView,
  lanes: ReadonlyMap<string, LaneView>,
): RunAgainPrefill | null {
  const members = fanout.laneIds
    .map((id, index) => ({ lane: lanes.get(id), index }))
    .filter((one): one is { lane: LaneView; index: number } => one.lane !== undefined)
    .sort((a, b) => (a.lane.fanoutSlot ?? a.index) - (b.lane.fanoutSlot ?? b.index))
    .map((one) => one.lane);
  const first = members[0];
  if (first === undefined) return null;
  return {
    projectRoot: first.projectRoot,
    text: first.source.kind === "issue" ? first.source.url : fanout.prompt,
    models: members.map((lane) => lane.model),
  };
}

export function agoText(createdAt: number, now: number, locale: string): string {
  const minutes = Math.max(0, Math.round((now - createdAt) / 60_000));
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (minutes < 60) return format.format(-minutes, "minute");
  if (minutes < 60 * 24) return format.format(-Math.round(minutes / 60), "hour");
  return format.format(-Math.round(minutes / (60 * 24)), "day");
}
