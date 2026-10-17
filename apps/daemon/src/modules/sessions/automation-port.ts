import { rmSync } from "node:fs";
import {
  type ApprovalMode,
  type Caller,
  PapError,
  type Permission,
  type PolicyRules,
  type ShellStreamEvent,
  type ToolPreset,
} from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { resolveSessionCwd } from "./cwd.ts";
import type { LiveSession } from "./live-session.ts";
import type { WorkerRoom } from "./worker-room.ts";
import type { MarksStore } from "./marks-store.ts";
import { isPiSessionFile } from "./pi-files.ts";
import type { SessionsServiceDeps, SessionsService } from "./service-types.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow, StoredPreset } from "./store.ts";

/** The fixed caller of the runner: never built from params, never leaves the sessions module (audit actor `system`, M10R159). */
export const AUTOMATION_CREDENTIAL = "automation";

export interface TaskSessionPolicy {
  readonly mode: "read-only" | "supervised" | "auto-accept-edits";
  readonly tools: readonly string[];
  readonly preset: "read-only" | "full";
  readonly tainted: boolean;
}

export interface SessionsAutomationPort {
  /**
   * `invalid_cwd`; `capacity` (the cap, the memory floor, or the last free worker: M10R154); `disk_low` (Task 16);
   * `worker_failed`. The policy is in the first init and stored with the row, unattended (M10R31).
   */
  createTaskSession(input: {
    ownerId: string;
    cwd: string;
    policy: TaskSessionPolicy;
  }): Promise<{ sessionId: string }>;
  /** A cold session is reopened only when a worker stays free for the owner afterwards (`capacity` otherwise). */
  prompt(input: {
    ownerId: string;
    sessionId: string;
    text: string;
    /** See `PromptInput.stillWanted`: false at the last moment drops the prompt (`handled`). */
    stillWanted?: () => boolean;
    /** Owner a5: refused with `sandbox_unavailable` unless the worker runs (or starts) in its sandbox. */
    sandboxedOnly?: boolean;
  }): Promise<"started" | "queued" | "handled">;
  /**
   * A `prompt` now would not be refused for capacity: the session is warm, or a worker stays free for the owner and the
   * free-memory floor holds (the checks `launch` makes for a cold reopen).
   */
  admits(ownerId: string, sessionId: string): boolean;
  /** A prompt or a reopen is in flight whose run has not started: input the resume must not race (M10R105). */
  promptPending(ownerId: string, sessionId: string): boolean;
  abort(ownerId: string, sessionId: string): Promise<void>;
  /** M9's `releaseIdle` (agreement 11): stops the worker when quiet, leaves it alone otherwise, `cold` when there is none. */
  releaseIdle(ownerId: string, sessionId: string): "released" | "busy" | "cold";
  /** Owner m10a3: every open approval of the session answered `deny`, every other dialog `cancelled`; how many. */
  answerUnattended(ownerId: string, sessionId: string): number;
  /** M4's archive mark (reversible, Undo in the archived list): a task session that ended `done` (owner m10q10). */
  archive(ownerId: string, sessionId: string): void;
  /** Owner m10q10: the row (its policy row cascades) and its Pi file; never a session with a live or starting worker. */
  deleteTaskSession(ownerId: string, sessionId: string): "deleted" | "busy" | "gone";
  state(
    ownerId: string,
    sessionId: string,
  ): { archived: boolean; running: boolean; needsInput: boolean } | null;
  /** A session's `needsInput` changed (the shell publisher's flush); a throwing listener is logged and skipped. */
  onAttention(listener: (sessionId: string, needsInput: boolean) => void): () => void;
  /** `updated_at` of the row: the attachment cleanup's clock (Task 16) and the "never reopened" test (M10R155). */
  lastActivityAt(sessionId: string): number | null;
  /** Workers up or starting, and the cap: `/metrics` (Task 14). */
  workers(): { used: number; max: number };
}

/** The runner as a caller: the session's owner, the two permissions its calls need, and no step-up. */
export const automationCaller = (ownerId: string): Caller => ({
  userId: ownerId,
  permissions: new Set<Permission>(["sessions:read", "sessions:operate"]),
  kind: "session",
  credentialId: AUTOMATION_CREDENTIAL,
  stepUpUntil: 0,
});

/** Who the audit row of an answered call names (M10R159): the runner's timeout denials are not the owner's answers. */
export const auditActorOf = (caller: Caller): "user" | "token" | "system" =>
  caller.credentialId === AUTOMATION_CREDENTIAL ? "system" : caller.kind === "token" ? "token" : "user";

/**
 * The task part of a session's rules (M10R30, M10R31). A session whose policy row is stored reads it. A new task session
 * has none until its first transaction commits, and uses the policy its in-memory row carries: never a window without.
 */
export function taskRules(
  row: SessionRow,
  stored: {
    mode: ApprovalMode;
    toolAllowlist: readonly string[] | null;
    unattended: boolean;
    recorded: boolean;
  },
): Partial<Pick<PolicyRules, "approvalMode" | "taint" | "toolAllowlist" | "unattended">> {
  if (stored.recorded)
    return {
      toolAllowlist: stored.toolAllowlist && [...stored.toolAllowlist],
      unattended: stored.unattended,
      // Second lock (M10R153): whatever reached the stored mode, an unattended run is never full-access.
      ...(stored.unattended && stored.mode === "full-access" ? { approvalMode: "supervised" as const } : {}),
    };
  const { task } = row;
  if (!task) return { toolAllowlist: null, unattended: false };
  // The mode and the taint too: the stored ones are the owner's default and untainted until the row is stored.
  return {
    approvalMode: task.mode,
    taint: { tainted: task.tainted, epoch: 0 },
    toolAllowlist: [...task.tools],
    unattended: true,
  };
}

/** The `tools` of an init record: the preset, and the closed list the rules carry (the worker pins it, M10R28). */
export const initTools = (
  preset: StoredPreset | null,
  rules: PolicyRules,
): { preset: ToolPreset; allowlist?: string[] } => ({
  preset: preset ?? "configured",
  ...(rules.toolAllowlist ? { allowlist: [...rules.toolAllowlist] } : {}),
});

/** Stores a new session's row; a task session's policy goes in the same transaction (M10R31): both or nothing. */
export function storeNewSession(
  deps: Pick<SessionsServiceDeps, "store" | "policy" | "clock">,
  row: SessionRow,
  projectId: string | null,
): void {
  deps.store.transaction(() => {
    deps.store.insert(row, projectId);
    const { task } = row;
    if (task)
      deps.policy.setTaskPolicy(row.ownerId, row.id, {
        mode: task.mode,
        tools: task.tools,
        taintedAt: task.tainted ? deps.clock.now() : null,
      });
  });
}

export interface Attention {
  /** The hub the shell publisher writes to: after each `session` event, the listeners hear of a changed `needsInput`. */
  wrap(hub: Pick<StreamHub, "publish">): Pick<StreamHub, "publish">;
  on(listener: (sessionId: string, needsInput: boolean) => void): () => void;
}

/** Feeds `onAttention` from the shell publisher's flush (M10R33): no timer, no polling. */
export function createAttention(logger: Logger): Attention {
  const listeners = new Set<(sessionId: string, needsInput: boolean) => void>();
  // The sessions last reported as waiting for an answer: a flush that repeats the state says nothing.
  const waiting = new Set<string>();
  const report = (sessionId: string, needsInput: boolean) => {
    if (waiting.has(sessionId) === needsInput) return;
    if (needsInput) waiting.add(sessionId);
    else waiting.delete(sessionId);
    for (const listener of [...listeners]) {
      try {
        listener(sessionId, needsInput);
      } catch (error) {
        logger.warn("attention_listener_failed", { sessionId, err: error });
      }
    }
  };
  return {
    wrap: (hub) => ({
      publish(stream, key, event) {
        hub.publish(stream, key, event);
        const shell = event as ShellStreamEvent;
        if (stream === "shell" && shell.kind === "session")
          report(shell.session.id, shell.session.needsInput);
      },
    }),
    on(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
}

/** What the port needs of the service: its internals. */
export interface AutomationContext {
  readonly deps: SessionsServiceDeps;
  readonly live: ReadonlyMap<string, LiveSession>;
  readonly starting: ReadonlySet<LiveSession>;
  readonly reopening: ReadonlyMap<string, Promise<LiveSession>>;
  launch(row: SessionRow, isNew: boolean): Promise<LiveSession>;
  readonly attention: Attention;
  readonly publisher: ShellPublisher;
  readonly marks: MarksStore;
  /** The owner's last worker stays free (M10R154); the ids a launch must keep free for or bring up sandboxed. */
  readonly room: Pick<WorkerRoom, "keepOneFree" | "keepFreeFor" | "sandboxedOnly">;
  /** The worker of this session started with its sandbox on. */
  sandboxed(sessionId: string): boolean;
  /** A session row was deleted: a child's prompt file goes, the stop of its children is told (M11R139 c, W5-R62). */
  removed(row: SessionRow): void;
}

/** The only way the automation and runs modules reach sessions (M10R32). */
export function createAutomationPort(
  ctx: AutomationContext,
  // The service itself, read when a call comes in: the port is built before the object it belongs to.
  service: () => Pick<SessionsService, "prompt" | "abort" | "respondDialog" | "mark" | "releaseIdle">,
): SessionsAutomationPort {
  const { deps, live, reopening } = ctx;
  const ownedRow = (ownerId: string, sessionId: string): SessionRow => {
    const row = deps.store.get(sessionId);
    if (!row || row.ownerId !== ownerId) throw new PapError("not_found");
    return row;
  };
  const { keepOneFree } = ctx.room;
  const warm = (sessionId: string) => {
    const session = live.get(sessionId);
    return (session !== undefined && !session.stopping()) || reopening.has(sessionId);
  };
  return {
    async createTaskSession({ ownerId, cwd, policy }) {
      if (policy.tools.length === 0) throw new PapError("bad_request");
      const resolved = resolveSessionCwd(cwd, deps.worker.papHome);
      deps.admission?.task();
      keepOneFree();
      const now = deps.clock.now();
      const row: SessionRow = {
        id: deps.newId(),
        piPath: null,
        piSessionId: null,
        cwd: resolved,
        ownerId,
        name: null,
        createdAt: now,
        updatedAt: now,
        toolPreset: policy.preset,
        task: policy,
      };
      await ctx.launch(row, true);
      ctx.publisher.changed(row.id);
      ctx.publisher.projectChanged(ownerId, ctx.marks.row(row.id)?.projectId ?? null);
      return { sessionId: row.id };
    },
    async prompt({ ownerId, sessionId, text, stillWanted, sandboxedOnly = false }) {
      ownedRow(ownerId, sessionId);
      const cold = !warm(sessionId);
      if (sandboxedOnly && !cold && !ctx.sandboxed(sessionId)) throw new PapError("sandbox_unavailable");
      if (cold) keepOneFree();
      // A cold agent session starts through the gate's await: the check is made again inside `launch`, after it.
      const recheck = cold && ownedRow(ownerId, sessionId).agentId !== undefined;
      if (recheck) ctx.room.keepFreeFor.add(sessionId);
      // Last before the `try`, whose `finally` removes it: nothing between can throw and leave the mark behind.
      // Set for a warm worker too: a pending memory release restarts it inside the prompt (31 m3).
      if (sandboxedOnly) ctx.room.sandboxedOnly.add(sessionId);
      try {
        const { disposition } = await service().prompt(
          { sessionId, text, ...(stillWanted ? { stillWanted } : {}) },
          automationCaller(ownerId),
        );
        return disposition;
      } finally {
        if (recheck) ctx.room.keepFreeFor.delete(sessionId);
        if (sandboxedOnly) ctx.room.sandboxedOnly.delete(sessionId);
      }
    },
    admits(ownerId, sessionId) {
      ownedRow(ownerId, sessionId);
      if (warm(sessionId)) return true;
      if (deps.freeMemMb() < deps.limits.minFreeMemMb) return false;
      try {
        keepOneFree();
        return true;
      } catch (error) {
        if (error instanceof PapError && error.code === "capacity") return false;
        throw error;
      }
    },
    promptPending(ownerId, sessionId) {
      ownedRow(ownerId, sessionId);
      const session = live.get(sessionId);
      return (
        reopening.has(sessionId) ||
        // A prompt held in the lane hooks (a restore, a checkpoint) has not reached the worker yet (M9R114).
        (deps.laneHooks?.waiting(sessionId) ?? false) ||
        (session !== undefined && !session.stopping() && session.busy())
      );
    },
    async abort(ownerId, sessionId) {
      ownedRow(ownerId, sessionId);
      await service().abort(sessionId, automationCaller(ownerId));
    },
    releaseIdle(ownerId, sessionId) {
      ownedRow(ownerId, sessionId);
      return service().releaseIdle(ownerId, sessionId);
    },
    answerUnattended(ownerId, sessionId) {
      ownedRow(ownerId, sessionId);
      const session = live.get(sessionId);
      if (!session || session.stopping()) return 0;
      let answered = 0;
      for (const dialog of session.dialogs()) {
        const response =
          dialog.method === "approval" ? { answer: "deny" as const } : { cancelled: true as const };
        try {
          service().respondDialog({ sessionId, dialogId: dialog.id, response }, automationCaller(ownerId));
          answered += 1;
        } catch (error) {
          deps.logger.warn("unattended_answer_failed", { sessionId, err: error });
        }
      }
      return answered;
    },
    archive(ownerId, sessionId) {
      ownedRow(ownerId, sessionId);
      service().mark({ sessionId, change: { kind: "archive" } }, automationCaller(ownerId));
    },
    deleteTaskSession(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId) return "gone";
      if (live.has(sessionId) || reopening.has(sessionId)) return "busy";
      const projectId = ctx.marks.row(sessionId)?.projectId ?? null;
      deps.store.remove(sessionId);
      ctx.publisher.countsChanged(ownerId);
      ctx.publisher.projectChanged(ownerId, projectId);
      ctx.removed(row);
      // Only a file under Pi's sessions folder, and only that path: a link is unlinked, never followed (M10R155).
      if (row.piPath && isPiSessionFile(deps.worker.agentDir, row.piPath)) {
        try {
          rmSync(row.piPath, { force: true });
        } catch (error) {
          deps.logger.warn("task_session_file_not_removed", { sessionId, err: error });
        }
      }
      return "deleted";
    },
    state(ownerId, sessionId) {
      const row = deps.store.get(sessionId);
      if (!row || row.ownerId !== ownerId) return null;
      const session = live.get(sessionId);
      return {
        archived: ctx.marks.row(sessionId)?.marks.archivedAt != null,
        running: session?.status() === "running",
        needsInput: (session?.dialogs().length ?? 0) > 0,
      };
    },
    onAttention: ctx.attention.on,
    lastActivityAt: (sessionId) => deps.store.get(sessionId)?.updatedAt ?? null,
    workers: () => ({ used: live.size + ctx.starting.size, max: deps.limits.maxWorkers }),
  };
}
