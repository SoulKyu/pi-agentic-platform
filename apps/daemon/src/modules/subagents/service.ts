import {
  fenceText,
  PapError,
  type PlatformError,
  type SubagentProfileFile,
  type SubagentState,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { type PlatformContext, PlatformRefusal } from "../platform/index.ts";
import type { RunEndEvent, RunsPort } from "../runs/index.ts";
import type { ChildProfile } from "../sessions/index.ts";
import type { SubagentStop } from "./stop.ts";
import type { SubagentStore } from "./store.ts";

/** The answer a child gives back: its last assistant text, at most this many characters (M11R137). */
export const SUBAGENT_ANSWER_CHARS = 51_200;
/** Children one owner may start in an hour (M11R137). */
export const SUBAGENT_PER_HOUR = 30;
const HOUR_MS = 3_600_000;
const TITLE_CHARS = 120;
const RELEASE_TRIES = 5;
const RELEASE_RETRY_MS = 2_000;

export interface SubagentSessions {
  /** A child would not be refused for capacity now (one worker stays free for the owner, M10R154). */
  admits(ownerId: string): boolean;
  createChild(input: {
    ownerId: string;
    parentSessionId: string;
    profile: ChildProfile | null;
  }): Promise<{ sessionId: string; tainted: boolean }>;
  /** Asked once, right before the prompt reaches the worker (after any lane hook): false drops it as `handled` (M10's N1). */
  prompt(input: {
    ownerId: string;
    sessionId: string;
    text: string;
    stillWanted?: () => boolean;
  }): Promise<unknown>;
  /** The parent is the owner's and not archived: a child is not made for one that is gone. */
  parentOpen(ownerId: string, parentSessionId: string): boolean;
  abort(ownerId: string, sessionId: string): Promise<void>;
  lastText(ownerId: string, sessionId: string, max: number): Promise<string | null>;
  /** The session's taint now; null when the session is gone. */
  taintedOf(sessionId: string): boolean | null;
  /** M9's `releaseIdle`: stops the worker when it is quiet, `busy` when it is not, `cold` when there is none. */
  releaseIdle(ownerId: string, sessionId: string): "released" | "busy" | "cold";
  /** The parent's screen is told its children changed (a new one, an ending). */
  changed(parentSessionId: string): void;
}

export interface SubagentRuns {
  onRunEnd: RunsPort["onRunEnd"];
  expectOrigin: RunsPort["expectOrigin"];
  clearExpected: RunsPort["clearExpected"];
  openTaskOf: RunsPort["openTaskOf"];
}

export interface SubagentServiceDeps {
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly logger: Logger;
  newId(): string;
  readonly store: SubagentStore;
  readonly settings: {
    subagents(ownerId: string): { readonly enabled: boolean; readonly maxConcurrent: number };
  };
  readonly profiles: { get(ownerId: string, sessionId: string, name: string): Promise<SubagentProfileFile> };
  readonly sessions: SubagentSessions;
  readonly runs: SubagentRuns;
  /** The agent's own daily budget is used up (M11R74): its children's runs count in it. */
  readonly agents: { over(ownerId: string, agentId: string): boolean };
  /** Holds the child against every cause of a stop (M11R139). */
  readonly stop: SubagentStop;
}

const refusal = (code: PlatformError): PlatformRefusal => new PlatformRefusal(code);

/** What a child session that could not start tells the parent: a fixed code, never the daemon's words. */
const CREATE_CODES: Readonly<Record<string, PlatformError>> = {
  capacity: "unavailable",
  disk_low: "unavailable",
  sandbox_unavailable: "sandbox_unavailable",
  agent_paused: "paused",
  bad_request: "bad_request",
  not_found: "not_found",
};

/** How a child's run ended, as the row records it and as the parent's tool answers. */
const ENDINGS: Readonly<
  Record<
    Exclude<RunEndEvent["status"], "completed">,
    { state: Exclude<SubagentState, "starting" | "running" | "done">; reason: string; code: PlatformError }
  >
> = {
  failed: { state: "failed", reason: "provider", code: "internal" },
  limited: { state: "failed", reason: "usage_limit", code: "unavailable" },
  cancelled: { state: "cancelled", reason: "aborted", code: "cancelled" },
  interrupted: { state: "interrupted", reason: "crash", code: "internal" },
};

/** The first line of the task, on one line, without invisible characters, cut to the column's bound. */
function titleOf(task: string): string {
  const line = task.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const title = line
    .replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, TITLE_CHARS)
    .trim();
  return title === "" ? "Subagent" : title;
}

/**
 * The `subagent.run` op (M11R137): a durable child thread runs the task and its answer comes back to the parent's tool.
 * The dispatcher already judged the caller's type, taint and the switch; this checks the caps, makes the child, and holds the
 * call for the child's run (the dispatcher's deadline and the parent's cancel end it).
 */
export function createSubagentService(deps: SubagentServiceDeps) {
  const { store, sessions, runs, clock } = deps;
  const logger = deps.logger.child({ component: "subagent" });
  const timers = new Set<TimerHandle>();
  let stopped = false;

  /** Ends the row once, with the instant it ended. */
  const end = (
    id: string,
    state: Exclude<SubagentState, "starting" | "running">,
    reason: string | null,
  ): void => void store.finish(id, state, reason, clock.now());

  async function run(
    args: { task: string; profile?: string | undefined },
    ctx: PlatformContext,
  ): Promise<{ childId: string; answer: string; clipped: boolean; tainted: boolean }> {
    const { ownerId, sessionId: parentId } = ctx;
    const setting = deps.settings.subagents(ownerId);
    if (!setting.enabled) throw refusal("unavailable");
    if (ctx.signal.aborted) throw refusal("cancelled");
    // The caps, then the row: nothing awaits between the count and the insert, so two calls never share a slot.
    if (store.liveOf(parentId) >= setting.maxConcurrent) throw refusal("limit_reached");
    if (store.startedSince(ownerId, clock.now() - HOUR_MS) >= SUBAGENT_PER_HOUR)
      throw refusal("rate_limited");
    if (!sessions.parentOpen(ownerId, parentId)) throw refusal("not_found");
    if (!sessions.admits(ownerId)) throw refusal("unavailable");
    if (ctx.agentId !== null && deps.agents.over(ownerId, ctx.agentId)) throw refusal("budget");
    const id = deps.newId();
    store.start({
      id,
      ownerId,
      parentSessionId: parentId,
      profile: args.profile ?? null,
      title: titleOf(args.task),
      startedAt: clock.now(),
    });
    let childId: string | null = null;
    const listening: Array<() => void> = [];
    try {
      const profile =
        args.profile === undefined ? null : await readProfile(id, ownerId, parentId, args.profile);
      const child = await createChild(id, ownerId, parentId, profile);
      childId = child.sessionId;
      store.running(id, childId);
      sessions.changed(parentId);
      const settled = new Promise<RunEndEvent>((resolve) => {
        listening.push(
          runs.onRunEnd((event) => {
            if (event.sessionId === child.sessionId) resolve(event);
          }),
        );
      });
      // The origin first: the child's first run is the one that is tagged (M11R138).
      if (!runs.expectOrigin(childId, { origin: "subagent", taskId: runs.openTaskOf(parentId) })) {
        end(id, "failed", "origin_table_full");
        throw refusal("unavailable");
      }
      // From here every cause of a stop (the call's signal, the parent's run end, its archive, quarantine) ends the row and
      // aborts the child itself (M11R139): this call only waits for it and answers `cancelled`.
      const guard = deps.stop.guard({ rowId: id, ownerId, parentId, childId, signal: ctx.signal });
      listening.push(guard.release);
      // The parent may have been archived while the child was made: nothing told the guard (review M1).
      if (!sessions.parentOpen(ownerId, parentId)) guard.stop("parent_archived");
      if (guard.stopped()) throw refusal("cancelled");
      try {
        const text = ctx.tainted
          ? `The task below comes from a session that read external content.\n${fenceText(args.task, "subagent-task", deps.newId())}`
          : args.task;
        await sessions.prompt({ ownerId, sessionId: childId, text, stillWanted: () => !guard.stopped() });
      } catch (error) {
        runs.clearExpected(childId);
        end(id, "failed", "prompt_failed");
        logger.warn("subagent_prompt_failed", { sessionId: parentId, childId, err: error });
        throw refusal("internal");
      }
      const result = await Promise.race([settled, guard.cancelled]);
      if (typeof result === "string") throw refusal("cancelled");
      // The run is over: a stop from here on cannot take back an answer that is on its way (review M3).
      guard.release();
      if (result.status !== "completed") {
        const ending = ENDINGS[result.status];
        end(id, ending.state, ending.reason);
        throw refusal(ending.code);
      }
      const text = (await sessions.lastText(ownerId, childId, SUBAGENT_ANSWER_CHARS + 1)) ?? "";
      end(id, "done", null);
      return {
        childId,
        answer: text.slice(0, SUBAGENT_ANSWER_CHARS),
        clipped: text.length > SUBAGENT_ANSWER_CHARS,
        // A child whose session cannot be read is a tainted one: its answer is fenced (fail closed).
        tainted: sessions.taintedOf(childId) ?? true,
      };
    } catch (error) {
      // Whatever ended the call, the row ends with it; a row that already ended keeps how it ended.
      end(id, "failed", "internal");
      throw error;
    } finally {
      for (const stop of listening) stop();
      // The worker of a child that ended goes back to the pool at once; the child stays a session the owner can continue.
      if (childId !== null) {
        releaseLater(ownerId, childId, RELEASE_TRIES);
        sessions.changed(parentId);
      }
    }
  }

  /** Idle at once, else tried again shortly (the task runner's rule); a failing release is said and never fails the call. */
  function releaseLater(ownerId: string, childId: string, tries: number): void {
    try {
      if (sessions.releaseIdle(ownerId, childId) !== "busy" || tries <= 1) return;
      if (stopped) return;
      const handle = clock.setTimeout(() => {
        timers.delete(handle);
        releaseLater(ownerId, childId, tries - 1);
      }, RELEASE_RETRY_MS);
      timers.add(handle);
    } catch (error) {
      logger.warn("subagent_release_failed", { childId, err: error });
    }
  }

  async function readProfile(
    rowId: string,
    ownerId: string,
    parentId: string,
    name: string,
  ): Promise<ChildProfile> {
    try {
      const file = await deps.profiles.get(ownerId, parentId, name);
      return { tools: file.tools, prompt: file.prompt, model: file.model };
    } catch (error) {
      const code = error instanceof PapError ? error.code : "";
      if (code === "not_found") {
        end(rowId, "failed", "profile_not_found");
        throw refusal("not_found");
      }
      if (code === "conflict") {
        end(rowId, "failed", "profile_ambiguous");
        throw refusal("bad_request");
      }
      end(rowId, "failed", "profile_unreadable");
      logger.warn("subagent_profile_failed", { sessionId: parentId, err: error });
      throw refusal("unavailable");
    }
  }

  async function createChild(
    rowId: string,
    ownerId: string,
    parentId: string,
    profile: ChildProfile | null,
  ): Promise<{ sessionId: string; tainted: boolean }> {
    try {
      return await sessions.createChild({ ownerId, parentSessionId: parentId, profile });
    } catch (error) {
      const code = error instanceof PapError ? error.code : "";
      end(rowId, "failed", `child_${code || "failed"}`.slice(0, 64));
      const mapped = CREATE_CODES[code];
      if (mapped === undefined) logger.warn("subagent_child_failed", { sessionId: parentId, err: error });
      throw refusal(mapped ?? "internal");
    }
  }

  return {
    run,
    /** The daemon stops: no retry of a release is left to fire. */
    stop(): void {
      stopped = true;
      for (const handle of timers) clock.clearTimeout(handle);
      timers.clear();
    },
    /** The owner's switch (owner m12), read at every worker start and every call. */
    enabled: (ownerId: string): boolean => deps.settings.subagents(ownerId).enabled,
  };
}
