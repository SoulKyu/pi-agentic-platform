import {
  type DaemonToWorker,
  type PackagePicks as PackagePicksSchema,
  SessionAppend,
  type SessionResync as SessionResyncSchema,
} from "@pap/contracts";
import type { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { classifyExit, type WorkerExit } from "../../kernel/supervisor/exit.ts";
import { killLadder, WORKER_SHUTDOWN_GRACE_MS } from "../../kernel/supervisor/kill-ladder.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { createWorkerCore } from "../../kernel/supervisor/worker-core.ts";
import { boundedOutbound, requestTimeoutMs } from "../../kernel/supervisor/worker-io.ts";

export type PackagePicks = z.infer<typeof PackagePicksSchema>;
type SessionResync = z.infer<typeof SessionResyncSchema>;

/** One end of an accepted connection, as the guest link and the worker handles use it. */
export interface Wire {
  /** Encodes and writes one frame. False when it cannot be sent (closed, over the frame bound, a peer that never reads); never throws. */
  send(frame: unknown): boolean;
  close(): void;
  /** R32: reads nothing more from the connection until `resume` (a long line is parsed meanwhile). Idempotent. */
  pause(): void;
  resume(): void;
}

/** What a worker's handle needs to keep its session mirror (T9b implements it). */
export interface WorkerSpawnInput {
  /** The VM file the guest names at spawn (a reopen), as a basename, or null (a new session). */
  readonly sessionFile: string | null;
  /** The VM's sessions folder: the spawn command names the file by its absolute path. */
  readonly sessionsDir: string;
  /** ADR 0080: the extra environment the guest may add to the worker (it applies a closed allowlist); absent for most agents. */
  readonly env?: Readonly<Record<string, string>>;
  /** The mirror of `file`, opened at the hello (a reopen) or at the first `session_append` (a new session, R28). */
  mirrorFor(file: string): MirrorPort | "refused";
  /** Every prompt, steer and follow-up text sent to this worker (R32). */
  sent(text: string): void;
  /** Whether a user message of the worker's events is one pap did not send (R32), looked at without consuming the match. */
  unsent(message: unknown): boolean;
  /** AVM-E40: a reopened session's worker came without the recorded file (the VM lost it): the owner is told. */
  lost?(): void;
}
/** What the mirror says of one `session_append`: taken, the worker must send from elsewhere (RT-39), or the connection ends. */
export type AppendResult = "ok" | { resync: SessionResync } | "refused";
export interface MirrorPort {
  /** Where the mirror lives on the host: what `piFile()` answers. */
  readonly path: string;
  facts(): { size: number; lastEntryId: string | null };
  /** A line over 1 MiB is parsed in the parse thread: the answer is then a promise, and the connection is paused until it settles (R32). */
  onSessionAppend(append: SessionAppend): AppendResult | Promise<AppendResult>;
  /** The worker's connection ended: a partial line is dropped, a replacement left short keeps its old copy (R14). Idempotent. */
  close(): void;
}

export interface VmWorkerHandle extends WorkerHandle {
  /** The guest's slot id of this worker: the shell overlay's folder is named by it (R27). */
  readonly slot: string;
  /** The mirror's path once it is open. */
  piFile(): string | null;
  /** R32, live: the message is a user message pap did not send (an extension's or a forged one). */
  unsentUserMessage(message: unknown): boolean;
}

export interface VmWorker {
  readonly handle: VmWorkerHandle;
  /** One frame from the worker's connection (not a ping or pong). */
  receive(raw: unknown): void;
  /** The worker's connection closed. */
  wireClosed(): void;
  /** The guest reported the worker's process ended. */
  guestExited(exit: WorkerExit, tail: string): void;
}

export function createVmWorker(deps: {
  clock: Clock;
  logger: Logger;
  label: Record<string, unknown>;
  slot: string;
  input: WorkerSpawnInput;
  wire: Wire;
  /** What the worker's hello said about its session file. */
  reported: { file: string | null; size: number; lastEntryId: string | null };
  /** The mirror opened for `reported.file` at the hello, or null. */
  mirror: MirrorPort | null;
  /** A signal to the worker's process through the guest. */
  signal(signal: "SIGTERM" | "SIGKILL"): void;
}): VmWorker {
  const { clock, logger, label, input, wire } = deps;
  const core = createWorkerCore({ clock, logger, label });
  let mirror = deps.mirror;
  let mirrorFile = mirror ? deps.reported.file : null;
  let alive = true;
  /** R32: the mirror is parsing a long line; every frame that arrives meanwhile waits here, in order (AVM-E14). */
  let blocked = false;
  const held: unknown[] = [];
  let tail = "";
  let stopping: Promise<WorkerExit> | undefined;
  let resolveExited: (exit: WorkerExit) => void = () => {};
  const exited = new Promise<WorkerExit>((resolve) => {
    resolveExited = resolve;
  });

  const finish = (exit: WorkerExit): void => {
    if (!alive) return;
    alive = false;
    held.length = 0;
    core.failPending();
    mirror?.close();
    resolveExited(exit);
  };
  const end = (exit: WorkerExit): void => {
    if (!alive) return;
    finish(exit);
    wire.close();
  };
  const refuse = (reason: string): void => {
    logger.warn("agent_vm_mirror_refused", { ...label, reason });
    deps.signal("SIGKILL");
    end(classifyExit(null, null));
  };

  const send = (record: DaemonToWorker): boolean => {
    if (!alive) return false;
    try {
      if (record.type === "prompt") input.sent(record.message);
      return wire.send(boundedOutbound(record));
    } catch (error) {
      logger.warn("agent_vm_send_failed", { ...label, err: error });
      return false;
    }
  };

  const settle = (result: AppendResult): void => {
    if (result === "ok") return;
    if (result === "refused") return refuse("append");
    send(result.resync);
  };
  const append = (record: SessionAppend): void => {
    if (mirrorFile !== null && record.file !== mirrorFile) return refuse("file");
    if (mirror === null) {
      const opened = input.mirrorFor(record.file);
      if (opened === "refused") return refuse("mirror");
      mirror = opened;
      mirrorFile = record.file;
    }
    const result = mirror.onSessionAppend(record);
    if (!(result instanceof Promise)) return settle(result);
    blocked = true;
    wire.pause();
    void result
      .then(
        (outcome) => {
          if (alive) settle(outcome);
        },
        () => {
          if (alive) refuse("append");
        },
      )
      .then(() => {
        blocked = false;
        drain();
        if (alive && !blocked) wire.resume();
      })
      .catch((error: unknown) => {
        logger.warn("agent_vm_mirror_drain_failed", { ...label, err: error });
        refuse("drain");
      });
  };
  const MAX_HELD_FRAMES = 256;
  const receive = (raw: unknown): void => {
    if (!alive) return;
    if (blocked) {
      if (held.length >= MAX_HELD_FRAMES) return refuse("backlog");
      held.push(raw);
      return;
    }
    if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "session_append") {
      const parsed = SessionAppend.safeParse(raw);
      if (parsed.success) return append(parsed.data);
    }
    core.receive(raw);
  };
  function drain(): void {
    while (alive && !blocked && held.length > 0) receive(held.shift());
  }

  if (mirror) {
    const facts = mirror.facts();
    if (facts.size !== deps.reported.size || facts.lastEntryId !== deps.reported.lastEntryId) {
      send({ type: "session_resync", fromOffset: facts.size, lastEntryId: facts.lastEntryId });
    }
  }

  function stop(): Promise<WorkerExit> {
    if (!alive) return exited;
    stopping ??= killLadder(
      {
        shutdown: () => void send({ type: "shutdown", graceMs: WORKER_SHUTDOWN_GRACE_MS }),
        signal: (signal) => {
          deps.signal(signal);
          return true;
        },
        exited,
      },
      clock,
    ).then((exit) => {
      end(exit);
      return exited;
    });
    return stopping;
  }

  const handle: VmWorkerHandle = {
    pid: undefined,
    exited,
    send,
    request: (command, timeoutMs = requestTimeoutMs(command)) => core.request(command, timeoutMs, send),
    onRecord: core.onRecord,
    stop,
    outputTail: () => tail,
    stats: core.stats,
    slot: deps.slot,
    piFile: () => mirror?.path ?? null,
    unsentUserMessage: (message) => input.unsent(message),
  };

  return {
    handle,
    receive,
    wireClosed: () => finish(classifyExit(null, null)),
    guestExited(exit, text) {
      if (!alive) return;
      tail = text;
      end(exit);
    },
  };
}
