import { PapError, type ScriptKind } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { EnvSource } from "../../kernel/child-env.ts";
import type { Logger } from "../../kernel/logger.ts";
import { releaseGroup, signalGroup, trackGroup } from "../../kernel/supervisor/process-group.ts";
import type { WorkerScope, WorkerScopes } from "../../kernel/supervisor/scope.ts";
import { deleteLogs, type LogChunk, type LogSink, openLog, readLog, tailLog } from "./script-log.ts";
import { type ProcProbe, procTag, recoverOrphans } from "./script-orphans.ts";
import {
  SCRIPT_DEADLINE_MS,
  SCRIPT_TERM_GRACE_MS,
  SCRIPTS_PER_OWNER,
  type ScriptChild,
  scriptEnv,
  scriptSpec,
  type SpawnScript,
} from "./script-spawn.ts";
import type { LaneRef, ScriptState, ScriptStateName, ScriptStore } from "./script-store.ts";

export type { LaneRef, ScriptState } from "./script-store.ts";

/** A script's text as the owner approved it, or why there is none to run. */
export type ApprovedScript =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly reason: "none" | "unapproved" };

export type RunResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: "none" | "unapproved" | "running" };

export interface GroupOps {
  track(pid: number): void;
  release(pid: number): void;
  signal(pid: number, signal: NodeJS.Signals): boolean;
}
export const REAL_GROUPS: GroupOps = {
  track: trackGroup,
  release: releaseGroup,
  signal: (pid, signal) => signalGroup(pid, signal),
};

export const SHUTDOWN_GRACE_MS = 2000;

export interface ScriptRunnerDeps {
  readonly store: ScriptStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** `$PAP_HOME`: the logs live in `lanes/<laneId>/`. */
  readonly home: string;
  /** The daemon's environment: only the unattended allowlist of it reaches a script. */
  readonly env: EnvSource;
  /** The umask the daemon started with (R114). */
  readonly umask: number;
  readonly scopes: Pick<WorkerScopes, "next">;
  /** The script of that kind in the project's file as it is NOW, when the owner approved exactly that text (Task 4). */
  approved(ownerId: string, projectRoot: string, kind: ScriptKind): Promise<ApprovedScript>;
  readonly spawn: SpawnScript;
  readonly probe: ProcProbe;
  readonly groups?: GroupOps;
  readonly readOnly: boolean;
  /** The lane changed: Task 6b's stream publishes it. */
  onChange?(laneId: string): void;
  /** Tests only. */
  readonly deadlines?: Partial<Record<ScriptKind, number>>;
  readonly termGraceMs?: number;
  readonly perOwner?: number;
}

export interface ScriptRunner {
  run(lane: LaneRef, kind: ScriptKind, options?: RunOptions): Promise<RunResult>;
  state(laneId: string, kind: ScriptKind): ScriptState;
  /** `not_found` for another owner's lane. */
  readLog(ownerId: string, laneId: string, kind: ScriptKind, offset: number): LogChunk;
  deleteLogs(laneId: string): void;
  /** The last bytes of the lane's log of that kind, as text; "" when there is none. */
  logTail(laneId: string, kind: ScriptKind, max: number): string;
  /** Resolves when the lane has no script queued or running (at once when it has none). */
  idle(laneId: string): Promise<void>;
  recover(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface RunOptions {
  keepLog?: boolean;
  /**
   * A script nobody clicked for (the test auto-run): judged synchronously right before the spawn, also after a wait in
   * the queue. False drops the job (state `none`) and calls `dropped`; the script does not run.
   */
  guard?: () => boolean;
  dropped?: () => void;
}

interface Job {
  readonly lane: LaneRef;
  readonly kind: ScriptKind;
  readonly guard?: () => boolean;
  readonly dropped?: () => void;
  /** The script's log goes after the lines already in it (the copy step's, for a lane's first setup). */
  readonly keepLog?: boolean;
}
interface Live {
  readonly job: Job;
  terminate(): void;
  readonly done: Promise<void>;
}

const SUCCESS: Record<ScriptKind, ScriptStateName> = { setup: "ok", archive: "ok", test: "passed" };

export function createScriptRunner(deps: ScriptRunnerDeps): ScriptRunner {
  const { store, clock } = deps;
  const logger = deps.logger.child({ module: "lane_scripts" });
  const groups = deps.groups ?? REAL_GROUPS;
  const perOwner = deps.perOwner ?? SCRIPTS_PER_OWNER;
  const termGrace = deps.termGraceMs ?? SCRIPT_TERM_GRACE_MS;
  /** `archive` has no column: its state is kept here, for this daemon's life. */
  const archiveStates = new Map<string, ScriptState>();
  /** One script per lane (a lane is here from `run` to the end of its script). */
  const busy = new Set<string>();
  const live = new Map<string, Live>();
  const queue: Job[] = [];
  const occupied = new Map<string, number>();
  let closed = false;

  const changed = (laneId: string): void => {
    try {
      deps.onChange?.(laneId);
    } catch (error) {
      logger.error("lane_script_change_failed", { err: error });
    }
  };
  function put(
    job: Job,
    state: ScriptStateName,
    exitCode: number | null | undefined,
    extra: { startedAt?: number; finishedAt?: number } = {},
  ): void {
    if (job.kind === "archive") archiveStates.set(job.lane.id, { state, exitCode: exitCode ?? null });
    else
      store.write(job.lane.id, job.kind, {
        state,
        ...(exitCode === undefined ? {} : { exitCode }),
        ...extra,
      });
    changed(job.lane.id);
  }
  const idlers = new Map<string, Array<() => void>>();
  const wake = (laneId: string): void => {
    for (const resolve of idlers.get(laneId) ?? []) resolve();
    idlers.delete(laneId);
  };
  const free = (job: Job): void => {
    busy.delete(job.lane.id);
    wake(job.lane.id);
    occupied.set(job.lane.ownerId, Math.max(0, (occupied.get(job.lane.ownerId) ?? 1) - 1));
  };

  /** Writes `running`, spawns, and records the group, with nothing in between that waits (M9R116). */
  function launch(job: Job, text: string): void {
    const { lane, kind } = job;
    const scope: WorkerScope | null = deps.scopes.next({ kind: "terminal" });
    let sink: LogSink | undefined;
    let child: ScriptChild | undefined;
    const startedAt = clock.now();
    try {
      sink = openLog(deps.home, lane.id, kind, logger, job.keepLog === true);
      const spec = scriptSpec({
        kind,
        script: text,
        umask: deps.umask,
        env: scriptEnv(deps.env, { id: lane.id, root: lane.projectRoot, worktree: lane.worktree }),
        scope: scope?.launch ?? null,
      });
      put(job, "running", null, { startedAt });
      child = deps.spawn(spec, lane.worktree);
      const tag = procTag(deps.probe, child.pid);
      if (tag !== null) store.setProc(lane.id, child.pid, tag);
    } catch (error) {
      logger.warn("lane_script_spawn_failed", {
        laneId: lane.id,
        kind,
        code: (error as NodeJS.ErrnoException).code ?? "unknown",
      });
      // The process may already be up when a later step failed: it must not outlive its row.
      if (child) groups.signal(child.pid, "SIGKILL");
      sink?.close();
      void scope?.reap({ signal: null });
      store.clearProc(lane.id);
      put(job, "failed", null, { finishedAt: clock.now() });
      free(job);
      pump();
      return;
    }
    const started = child;
    const log = sink;
    groups.track(started.pid);
    logger.info("lane_script_started", { laneId: lane.id, kind });
    started.onOutput((chunk) => log.write(chunk));
    let timers: TimerHandle[] = [];
    let interrupted = false;
    // A run whose deadline fired failed, whatever the script exits with on its SIGTERM (M9R29).
    let timedOut = false;
    const terminate = (grace: number): void => {
      groups.signal(started.pid, "SIGTERM");
      timers.push(clock.setTimeout(() => groups.signal(started.pid, "SIGKILL"), grace));
    };
    timers.push(
      clock.setTimeout(() => {
        timedOut = true;
        terminate(termGrace);
      }, deps.deadlines?.[kind] ?? SCRIPT_DEADLINE_MS[kind]),
    );
    const done = started.exited.then(async (exit) => {
      for (const timer of timers) clock.clearTimeout(timer);
      timers = [];
      // Whatever the script left in its group dies with it; the group id cannot be recycled while it has members.
      groups.signal(started.pid, "SIGKILL");
      groups.release(started.pid);
      await scope
        ?.reap({ signal: (exit.signal ?? null) as NodeJS.Signals | null })
        .catch((error: unknown) => {
          logger.error("lane_script_reap_failed", { err: error });
        });
      const { bytes } = log.close();
      store.clearProc(lane.id);
      const code = timedOut ? null : exit.code;
      const state: ScriptStateName = timedOut
        ? "failed"
        : interrupted
          ? "interrupted"
          : code === 0
            ? SUCCESS[kind]
            : "failed";
      put(job, state, code, { finishedAt: clock.now() });
      logger.info("lane_script_ended", {
        laneId: lane.id,
        kind,
        code,
        signal: exit.signal,
        ms: clock.now() - startedAt,
        logBytes: bytes,
      });
      live.delete(lane.id);
      free(job);
      pump();
    });
    live.set(lane.id, {
      job,
      done: done.catch((error: unknown) => logger.error("lane_script_end_failed", { err: error })),
      terminate() {
        interrupted = true;
        terminate(deps.termGraceMs ?? SHUTDOWN_GRACE_MS);
      },
    });
  }

  /** Starts queued jobs while their owners have a free place. The place is held across the approval re-check. */
  function pump(): void {
    if (closed) return;
    for (let at = 0; at < queue.length; at++) {
      const job = queue[at] as Job;
      if ((occupied.get(job.lane.ownerId) ?? 0) >= perOwner) continue;
      queue.splice(at--, 1);
      occupied.set(job.lane.ownerId, (occupied.get(job.lane.ownerId) ?? 0) + 1);
      void begin(job).catch((error: unknown) => {
        logger.error("lane_script_start_failed", { err: error });
        free(job);
      });
    }
  }

  /** The approval is judged again right before the spawn: a script changed since `run` never runs. */
  async function begin(job: Job): Promise<void> {
    const approved = await deps.approved(job.lane.ownerId, job.lane.projectRoot, job.kind);
    if (closed) {
      put(job, "interrupted", null);
      return free(job);
    }
    if (!approved.ok) {
      put(job, "unapproved", null);
      free(job);
      return pump();
    }
    if (!allowed(job)) return pump();
    launch(job, approved.text);
  }

  /** The job's own guard, evaluated with nothing awaited before the spawn; a refused job is dropped and its place freed. */
  function allowed(job: Job): boolean {
    if (job.guard === undefined || job.guard()) return true;
    put(job, "none", null);
    job.dropped?.();
    free(job);
    return false;
  }

  return {
    async run(lane, kind, options) {
      if (closed) throw new PapError("capacity");
      if (deps.readOnly) throw new PapError("read_only");
      if (busy.has(lane.id)) return { ok: false, reason: "running" };
      busy.add(lane.id);
      let approved: ApprovedScript;
      try {
        approved = await deps.approved(lane.ownerId, lane.projectRoot, kind);
      } catch (error) {
        busy.delete(lane.id);
        throw error;
      }
      if (!approved.ok) {
        busy.delete(lane.id);
        if (approved.reason === "unapproved") put({ lane, kind }, "unapproved", null);
        return approved;
      }
      const job: Job = {
        lane,
        kind,
        ...(options?.keepLog ? { keepLog: true } : {}),
        ...(options?.guard ? { guard: options.guard } : {}),
        ...(options?.dropped ? { dropped: options.dropped } : {}),
      };
      if (closed) {
        busy.delete(lane.id);
        throw new PapError("capacity");
      }
      if ((occupied.get(lane.ownerId) ?? 0) < perOwner) {
        occupied.set(lane.ownerId, (occupied.get(lane.ownerId) ?? 0) + 1);
        if (allowed(job)) launch(job, approved.text);
        else pump();
      } else {
        put(job, "queued", null);
        queue.push(job);
      }
      return { ok: true };
    },
    state: (laneId, kind) =>
      kind === "archive"
        ? (archiveStates.get(laneId) ?? { state: "none", exitCode: null })
        : store.read(laneId, kind),
    readLog: (ownerId, laneId, kind, offset) =>
      readLog({ home: deps.home, ownerOf: (id) => store.laneOf(id)?.ownerId }, ownerId, laneId, kind, offset),
    deleteLogs: (laneId) => deleteLogs(deps.home, laneId),
    logTail: (laneId, kind, max) => tailLog(deps.home, laneId, kind, max),
    idle: (laneId) =>
      busy.has(laneId)
        ? new Promise<void>((resolve) => idlers.set(laneId, [...(idlers.get(laneId) ?? []), resolve]))
        : Promise.resolve(),
    async recover() {
      recoverOrphans({
        store,
        probe: deps.probe,
        logger,
        killGroup: (pgid) => groups.signal(pgid, "SIGKILL"),
        onChange: changed,
      });
    },
    async shutdown() {
      closed = true;
      for (const job of queue.splice(0)) {
        put(job, "interrupted", null);
        busy.delete(job.lane.id);
        wake(job.lane.id);
      }
      const running = [...live.values()];
      for (const entry of running) entry.terminate();
      await Promise.all(running.map((entry) => entry.done));
    },
  };
}
