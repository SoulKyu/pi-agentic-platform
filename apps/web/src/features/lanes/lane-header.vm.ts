import { deriveLaneStatus, type LaneStatus, type LaneStatusReason, type LaneView } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";
import type { MessageKey } from "../../i18n/index.ts";
import { laneSessions } from "../../lib/lane-sessions.ts";

/** What the header needs of a session of the shell store. */
export interface SessionFacts {
  readonly cwd: string;
  readonly status: string;
  readonly needsInput: boolean;
  readonly archivedAt?: number | null;
}

/** M9R65: working -> run, needs_attention -> att, in_review -> you, done -> ok, idle -> mut. */
export const STATUS_TONE: Readonly<Record<LaneStatus, ChipTone>> = {
  archived: "mut",
  setup: "mut",
  needs_attention: "att",
  working: "run",
  done: "ok",
  in_review: "you",
  idle: "mut",
};

const dash = (value: number | null): string => (value === null ? "—" : String(value));

export interface PrBadge {
  readonly number: number;
  /** An http(s) address, else null: a forge's answer is not trusted to be a link. */
  readonly href: string | null;
  readonly state: MessageKey | null;
  readonly checks: ReadonlyArray<{
    readonly kind: "passed" | "failed" | "pending";
    readonly symbol: "✓" | "✗" | "…";
    readonly count: number;
  }>;
  readonly conflicts: boolean;
  readonly error: MessageKey | null;
}

export function prBadge(pr: NonNullable<LaneView["pr"]>): PrBadge {
  const state = pr.draft && pr.state === "open" ? "draft" : pr.state;
  const checks = pr.checks;
  return {
    number: pr.number,
    href: /^https?:\/\//.test(pr.url) ? pr.url : null,
    state: state === null ? null : (`lanes.pr.state.${state}` as MessageKey),
    checks:
      checks === null
        ? []
        : [
            { kind: "passed", symbol: "✓", count: checks.passed },
            { kind: "failed", symbol: "✗", count: checks.failed },
            { kind: "pending", symbol: "…", count: checks.pending },
          ].filter((one): one is PrBadge["checks"][number] => one.count > 0),
    conflicts: pr.conflicts === true,
    error: pr.error === null ? null : (`lanes.pr.error.${pr.error}` as MessageKey),
  };
}

export interface HeaderModel {
  readonly status: LaneStatus;
  readonly tone: ChipTone;
  readonly reason: MessageKey | null;
  readonly external: boolean;
  readonly facts: {
    readonly branch: string;
    readonly base: string;
    readonly ahead: string;
    readonly behind: string;
    readonly additions: string;
    readonly deletions: string;
  };
  readonly pr: PrBadge | null;
  readonly runSetup: boolean;
  /** A token chose the files and the base: shown next to Run setup (M8). */
  readonly byToken: boolean;
}

const reasonKey = (reason: LaneStatusReason | null, lane: LaneView): MessageKey | null => {
  if (reason === null) return null;
  if (reason === "create_failed")
    return lane.failedReason === null
      ? "lanes.reason.create_failed"
      : (`lanes.reason.create_failed.${lane.failedReason}` as MessageKey);
  return `lanes.reason.${reason}` as MessageKey;
};

/** Run setup is offered when it waits for the owner or ended badly (a token's lane never runs it by itself, M9R110). */
export const showsRunSetup = (lane: LaneView): boolean =>
  lane.state === "active" && ["pending", "failed", "interrupted", "unapproved"].includes(lane.setup.state);

export function headerModel(lane: LaneView, sessions: Iterable<SessionFacts>): HeaderModel {
  const own = laneSessions(lane, sessions);
  const { status, reason } = deriveLaneStatus(lane, {
    busy: own.some((session) => session.status === "running"),
    needsInput: own.some((session) => session.needsInput),
  });
  return {
    status,
    tone: STATUS_TONE[status],
    reason: reasonKey(reason, lane),
    external: lane.source.kind === "issue",
    facts: {
      branch: lane.branch,
      base: lane.baseLabel,
      ahead: dash(lane.facts?.ahead ?? null),
      behind: dash(lane.facts?.behind ?? null),
      additions: dash(lane.facts?.additions ?? null),
      deletions: dash(lane.facts?.deletions ?? null),
    },
    pr: lane.pr === null ? null : prBadge(lane.pr),
    runSetup: showsRunSetup(lane),
    byToken: lane.createdBy === "token",
  };
}

export interface NoticeModel {
  /** Stable for one notice: its kind and its time. */
  readonly id: string;
  readonly key: MessageKey;
  /** The plural base when the words depend on `count`. */
  readonly plural: MessageKey | null;
  readonly count: number | null;
  readonly startSession: boolean;
}

const COUNTED = new Set(["large_files_skipped", "copy_skipped", "nested_repo_left_out"]);

/** One line per notice, newest first (M9R65). */
export function noticeModels(notices: LaneView["notices"]): NoticeModel[] {
  return [...notices]
    .sort((a, b) => b.at - a.at)
    .map((notice) => {
      const base = `lanes.notice.${notice.kind}` as MessageKey;
      const counted = COUNTED.has(notice.kind);
      return {
        id: `${notice.kind}:${notice.at}`,
        key: counted && notice.count === null ? (`${base}.unknown` as MessageKey) : base,
        plural: counted && notice.count !== null ? base : null,
        count: notice.count,
        startSession: notice.kind === "session_failed",
      };
    });
}
