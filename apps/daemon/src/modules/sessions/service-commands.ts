import { type Caller, type CommandInput, PapError, UI_LIMITS } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { refusalOf } from "./live-commands.ts";
import type { LiveSession } from "./live-types.ts";
import { clipJsonText, type SessionReads } from "./service-reads.ts";
import type { SessionRow } from "./store.ts";
import { clip } from "./worker-text.ts";

/** An editor text is sent whole in the answer; once JSON-encoded it must stay well inside the 1 MiB frame. */
const EDITOR_TEXT_BYTES = 800_000;

export interface SessionCommandsDeps {
  owned(sessionId: string, caller: Caller): SessionRow;
  ensureLive(row: SessionRow): Promise<LiveSession>;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly reads: Pick<SessionReads, "ensureReader" | "snapshot">;
  readonly hub: Pick<StreamHub, "publish">;
  readonly logger: Logger;
}

export interface SessionCommands {
  /** Moves Pi's leaf to an entry (M2R90): answers when Pi has, then everyone watching is given a snapshot of the new branch. */
  navigate(
    input: { sessionId: string; targetId: string },
    caller: Caller,
  ): Promise<{ cancelled: boolean; editorText?: string }>;
  /** Compacts the session's context under the same busy rule, with no timeout either. */
  compact(
    input: { sessionId: string; customInstructions?: string | undefined },
    caller: Caller,
  ): Promise<{ tokensBefore: number; estimatedTokensAfter: number | null }>;
}

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export function createSessionCommands(deps: SessionCommandsDeps): SessionCommands {
  const { logger } = deps;

  // The worker's text is untrusted: it is logged clipped and never returned (R66, M2R87).
  const refused = (command: CommandInput["type"], error: string): PapError => {
    logger.warn("command_refused", { command, error: clip(error) });
    return new PapError(refusalOf(command, error));
  };

  // Navigating or compacting while a run, a prompt or another such command is on would change the branch under it
  // (Pi's `compact()` aborts the current operation). The check runs before the worker is brought up and again after:
  // a prompt may have arrived while it started. Nothing is awaited between the second check and the send, so no prompt
  // can slip in between (M2R88, M2-RT-08).
  async function send(sessionId: string, caller: Caller, input: CommandInput) {
    const row = deps.owned(sessionId, caller);
    if (deps.live.get(sessionId)?.busy()) throw new PapError("session_busy");
    const session = await deps.ensureLive(row);
    if (session.busy()) throw new PapError("session_busy");
    const answer = await session.command(input);
    if (!answer.ok) throw refused(input.type, answer.error);
    return { row, session, data: answer.data };
  }

  // Everyone watching is given the branch Pi is on now. A failure to do it must not look like a failed navigation.
  async function refresh(sessionId: string, row: SessionRow): Promise<void> {
    try {
      await deps.reads.ensureReader();
      deps.hub.publish("session", row.id, deps.reads.snapshot(row.id));
    } catch (error) {
      logger.warn("navigate_snapshot_failed", { sessionId, err: error });
      reloadNotice(row);
    }
  }
  const reloadNotice = (row: SessionRow): void =>
    deps.hub.publish("session", row.id, {
      kind: "notice",
      level: "warning",
      text: "The view could not be refreshed. Reload the page.",
      source: "pap",
    });

  return {
    async navigate({ sessionId, targetId }, caller) {
      const { row, session, data } = await send(sessionId, caller, { type: "navigate_tree", targetId });
      if (typeof data !== "object" || data === null) {
        logger.warn("navigate_answer_unreadable", { sessionId });
        // Pi may have moved all the same: a client must not keep showing a branch that is stale.
        reloadNotice(row);
        throw new PapError("command_failed");
      }
      const answer = data as { cancelled?: unknown; leafId?: unknown; editorText?: unknown };
      const cancelled = answer.cancelled === true;
      // Pi moved nothing when it cancelled: the view is still right, and a snapshot would only evict the replay.
      // No branch summary entry exists yet (the worker navigates with `summarize: false`); one written later would be
      // in the file, so the snapshot read from the new leaf would carry its row.
      if (!cancelled) {
        session.navigated(typeof answer.leafId === "string" ? answer.leafId : null);
        await refresh(sessionId, row);
      }
      const text =
        typeof answer.editorText === "string"
          ? clipJsonText(answer.editorText.slice(0, UI_LIMITS.editorText), EDITOR_TEXT_BYTES).text
          : undefined;
      return { cancelled, ...(text === undefined ? {} : { editorText: text }) };
    },
    async compact({ sessionId, customInstructions }, caller) {
      const { data } = await send(sessionId, caller, {
        type: "compact",
        ...(customInstructions === undefined ? {} : { customInstructions }),
      });
      const answer = (typeof data === "object" && data !== null ? data : {}) as {
        tokensBefore?: unknown;
        estimatedTokensAfter?: unknown;
      };
      // The compaction happened; an answer this daemon cannot read is a worker bug to log, not a failure to report.
      if (!isCount(answer.tokensBefore)) logger.warn("compact_answer_unreadable", { sessionId });
      return {
        tokensBefore: isCount(answer.tokensBefore) ? answer.tokensBefore : 0,
        estimatedTokensAfter: isCount(answer.estimatedTokensAfter) ? answer.estimatedTokensAfter : null,
      };
    },
  };
}
