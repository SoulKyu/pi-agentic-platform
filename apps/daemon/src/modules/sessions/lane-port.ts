import { type Caller, PapError, type SessionStatus, type ThinkingLevel } from "@pap/contracts";
import { within } from "../../kernel/fs/boundary.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits } from "../../kernel/text.ts";
import type { BranchPathEntry } from "./branch.ts";
import type { LaneRunInfo } from "./lane-hooks.ts";
import type { LiveSession } from "./live-session.ts";
import type { MarksStore } from "./marks-store.ts";
import type { SessionsService } from "./service-types.ts";
import type { SessionRow, SessionsStore } from "./store.ts";
import { clip } from "./worker-text.ts";

/** What the service lets the lane port see of its workers and files; nothing here writes. */
export interface LaneProbe {
  readonly live: ReadonlyMap<string, LiveSession>;
  /** `starting` for a session being reopened, `cold` for one with no worker. */
  statusOf(sessionId: string): SessionStatus;
  branchPath(
    caller: Caller,
    sessionId: string,
  ): Promise<{ leafId: string | null; entries: BranchPathEntry[] }>;
  agentText(sessionId: string, max: number, since?: number): Promise<string | null>;
}

/** What a suggested commit message may hold: the characters the model returns are untrusted text (M9R79). */
const MESSAGE_CHARS = 2000;
const HIDDEN = /(?![\n\t])[\p{Cc}\p{Cf}]/gu;
const LINE_SEPARATORS = /[\p{Zl}\p{Zp}]/gu;
const cleanMessage = (raw: unknown): string =>
  typeof raw === "string"
    ? cutUnits(
        raw.replace(/\r\n?/g, "\n").replace(LINE_SEPARATORS, "\n").replace(HIDDEN, ""),
        MESSAGE_CHARS,
      ).trim()
    : "";

export interface LaneModelChoice {
  readonly provider: string;
  readonly modelId: string;
  readonly thinking?: ThinkingLevel | undefined;
}

/** The only way lanes touch sessions (M9R37). Every call is for one owner; another owner's sessions are never seen. */
export interface SessionsLanePort {
  /** `SessionsService.create` unchanged, then the model when one is picked. A model Pi refuses leaves its default. */
  create(
    caller: Caller,
    worktree: string,
    model: LaneModelChoice | null,
  ): Promise<{ sessionId: string; modelRefused: boolean }>;
  prompt(
    caller: Caller,
    sessionId: string,
    text: string,
  ): Promise<{ disposition: "started" | "queued" | "handled" }>;
  /** The owner's unarchived sessions whose folder is `folder` or below. Busy: running, starting or a prompt pending. */
  activityIn(ownerId: string, folder: string): { sessions: number; busy: boolean; needsInput: boolean };
  /** The ids of the owner's sessions, archived ones included, whose folder is `folder` or below (the taint check of a script run). */
  sessionIdsIn(ownerId: string, folder: string): string[];
  /**
   * For the re-check under the lane lock: idle (nothing running or pending) and the live leaf. A cold session is idle.
   * `ownPrompt`: the prompt waiting in the lane hooks is the caller's own (the checkpoint capture it waits for), so it
   * does not count as pending.
   */
  runState(
    ownerId: string,
    sessionId: string,
    options?: { readonly ownPrompt?: boolean },
  ): { idle: boolean; leafId: string | null };
  /** Archives each unarchived session of the caller in the folder or below; answers how many. */
  archiveIn(caller: Caller, folder: string): number;
  /** Releases the quiet workers of the owner in the folder or below, through `releaseIdle`; `busy` counts those it left alone (a dialog, a panel, a queue, a command in flight). */
  releaseIn(ownerId: string, folder: string): { released: number; busy: number };
  lastAgentText(sessionId: string, max: number): Promise<string | null>;
  branchPath(
    caller: Caller,
    sessionId: string,
  ): Promise<{ leafId: string | null; entries: BranchPathEntry[] }>;
  /**
   * Asks the session's model, in its worker, for a commit message for `diff` (a cold session's worker is started, like
   * `autoName`). A side call: no run is registered and M10's daily budget does not count it (agreement C1). The text
   * comes back stripped of hidden characters and clipped; a refusal or an unusable answer is `model_failed`.
   */
  suggestCommit(
    caller: Caller,
    sessionId: string,
    diff: string,
  ): Promise<{ ok: true; message: string } | { ok: false; reason: "model_failed" }>;
}

export function createSessionsLanePort(deps: {
  readonly service: Pick<
    SessionsService,
    "create" | "setModel" | "setThinking" | "prompt" | "mark" | "releaseIdle" | "reopen"
  >;
  readonly store: Pick<SessionsStore, "listByOwner" | "get">;
  readonly marks: Pick<MarksStore, "row">;
  readonly probe: LaneProbe;
  /** A prompt of the session is waiting in the lane hooks: it counts as pending. */
  waiting(sessionId: string): boolean;
  readonly logger: Logger;
}): SessionsLanePort {
  const { probe } = deps;
  const inFolder = (ownerId: string, folder: string): SessionRow[] =>
    deps.store.listByOwner(ownerId).filter((row) => within(folder, row.cwd));
  const unarchived = (ownerId: string, folder: string): SessionRow[] =>
    inFolder(ownerId, folder).filter((row) => (deps.marks.row(row.id)?.marks.archivedAt ?? null) === null);
  const busy = (sessionId: string): boolean => {
    const status = probe.statusOf(sessionId);
    return (
      status === "running" ||
      status === "starting" ||
      probe.live.get(sessionId)?.busy() === true ||
      deps.waiting(sessionId)
    );
  };

  return {
    async create(caller, worktree, model) {
      const { sessionId } = await deps.service.create(worktree, caller);
      if (!model) return { sessionId, modelRefused: false };
      try {
        await deps.service.setModel({ sessionId, provider: model.provider, modelId: model.modelId }, caller);
        if (model.thinking) await deps.service.setThinking({ sessionId, level: model.thinking }, caller);
      } catch (error) {
        if (!(error instanceof PapError)) throw error;
        deps.logger.warn("lane_model_refused", { code: error.code });
        return { sessionId, modelRefused: true };
      }
      return { sessionId, modelRefused: false };
    },
    prompt: (caller, sessionId, text) => deps.service.prompt({ sessionId, text }, caller),
    activityIn(ownerId, folder) {
      const rows = unarchived(ownerId, folder);
      return {
        sessions: rows.length,
        busy: rows.some((row) => busy(row.id)),
        needsInput: rows.some((row) => (probe.live.get(row.id)?.dialogs().length ?? 0) > 0),
      };
    },
    // Archived sessions too: archiving a session keeps its edits and its taint (M9R119).
    sessionIdsIn: (ownerId, folder) => inFolder(ownerId, folder).map((row) => row.id),
    runState(ownerId, sessionId, options) {
      if (deps.store.get(sessionId)?.ownerId !== ownerId) return { idle: false, leafId: null };
      const session = probe.live.get(sessionId);
      if (!session) return { idle: probe.statusOf(sessionId) === "cold", leafId: null };
      return {
        idle:
          !session.stopping() &&
          session.status() === "idle" &&
          !session.busy() &&
          (options?.ownPrompt === true || !deps.waiting(sessionId)),
        leafId: session.leafId(),
      };
    },
    archiveIn(caller, folder) {
      let archived = 0;
      for (const row of unarchived(caller.userId, folder)) {
        try {
          deps.service.mark({ sessionId: row.id, change: { kind: "archive" } }, caller);
          archived += 1;
        } catch (error) {
          deps.logger.warn("lane_archive_session_refused", { err: error });
        }
      }
      return archived;
    },
    releaseIn(ownerId, folder) {
      let released = 0;
      let busy = 0;
      for (const row of inFolder(ownerId, folder)) {
        if (!probe.live.has(row.id) && probe.statusOf(row.id) !== "starting") continue;
        const answer = deps.service.releaseIdle(ownerId, row.id);
        if (answer === "released") released += 1;
        else if (answer === "busy") busy += 1;
      }
      return { released, busy };
    },
    lastAgentText: (sessionId, max) => probe.agentText(sessionId, max),
    branchPath: (caller, sessionId) => probe.branchPath(caller, sessionId),
    async suggestCommit(caller, sessionId, diff) {
      await deps.service.reopen(sessionId, caller);
      const session = probe.live.get(sessionId);
      if (!session) throw new PapError("worker_failed");
      const answer = await session.command({ type: "suggest_commit", diff });
      if (!answer.ok) {
        deps.logger.warn("lane_suggest_refused", { sessionId, error: clip(answer.error) });
        return { ok: false, reason: "model_failed" };
      }
      const message = cleanMessage((answer.data as { message?: unknown } | null)?.message);
      return message === "" ? { ok: false, reason: "model_failed" } : { ok: true, message };
    },
  };
}

/** The run info of a session for the lane hooks: its row and the live leaf; null when the session is gone. */
export const laneInfoOf = (
  store: Pick<SessionsStore, "get">,
  probe: Pick<LaneProbe, "live">,
  sessionId: string,
): LaneRunInfo | null => {
  const row = store.get(sessionId);
  return row
    ? { ownerId: row.ownerId, sessionId, cwd: row.cwd, leafId: probe.live.get(sessionId)?.leafId() ?? null }
    : null;
};
