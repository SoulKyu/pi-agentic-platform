import { MAX_FRAME_PAYLOAD, PapError, type BinarySink, type BinaryStream } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { PtyTarget } from "../../kernel/pty/kill.ts";
import { clampSize, PTY_COLS, PTY_ROWS, type PtyProcess } from "../../kernel/pty/spawn.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerScope } from "../../kernel/supervisor/scope.ts";
import { createFlow, type ExitInfo, type Flow } from "./flow.ts";
import { createRing } from "./ring.ts";

/** Streams attached to one terminal (M8R60). */
export const MAX_STREAMS_PER_TERMINAL = 8;
/** After the shell's exit, output that follows closely still counts (node-pty can report `exit` first, M8R58). */
export const EXIT_QUIET_MS = 100;
export const EXIT_WAIT_MAX_MS = 1000;
/**
 * While the PTY is paused, the shell is checked this often. node-pty waits 200 ms on a paused socket, then destroys
 * it and only then reports `exit`, so the last output is read only if the PTY resumes inside that window (MC27).
 */
export const ALIVE_POLL_MS = 50;

/** Field for field the contract's `TerminalView` (Task 12), which does not exist yet when this task runs. */
export interface TerminalState {
  readonly id: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  /** The box project the shell runs in (lot B2), null for a shell on this machine. */
  readonly projectId: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly status: "running" | "exited";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly createdAt: number;
}

export interface AttachInfo {
  readonly streamId: number;
  /**
   * Where the replay begins at attach time: `after` when the stream continues, else the ring's `safeStart()` (a
   * `reset` comes first). The first frame is authoritative: the ring can evict before the answer is committed,
   * and then the stream starts with a `reset` at another offset.
   */
  readonly start: number;
  readonly end: number;
  readonly cols: number;
  readonly rows: number;
  readonly status: "running" | "exited";
}

export interface Terminal {
  readonly id: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly createdAt: number;
  view(): TerminalState;
  /** Whether a browser stream is attached and when the shell last printed: a box idles out when no terminal of it has either. */
  activity(): { readonly streams: number; readonly lastOutputAt: number };
  /** The stream this connection already has here, if any (M8R58). */
  streamOf(connectionId: string): AttachInfo | null;
  /** `open` is the binary channel's: frames start at the sink's `onOpen` (M8R10). Throws `capacity` past 8 streams. */
  attach(
    connectionId: string,
    open: (sink: BinarySink) => BinaryStream,
    after: number | undefined,
  ): AttachInfo;
  /** The connection's own stream only: stream ids repeat across connections (the brief's `detach(streamId)` could not tell them apart). */
  detach(connectionId: string, streamId: number): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}

export interface TerminalDeps {
  readonly id: string;
  readonly ownerId: string;
  readonly cwd: string;
  readonly sessionId: string | null;
  readonly projectId: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly pty: PtyProcess;
  /** The terminal's own systemd scope, when there is one: reaped once the shell is gone. */
  readonly scope: Pick<WorkerScope, "reap"> | null;
  readonly clock: Clock;
  readonly logger: Logger;
  kill(target: PtyTarget): Promise<void>;
  /** Whether the shell process is still the one that was started (its /proc start time against the PTY's). */
  alive(): boolean;
  /** The view changed (size, exit). */
  changed(view: TerminalState): void;
  /** The shell's exit was recorded. */
  exited(): void;
  /** The terminal is gone (closed). */
  closed(): void;
}

interface Attached {
  readonly connectionId: string;
  readonly stream: BinaryStream;
  readonly flow: Flow;
  lastInput: number;
}

interface Finishing {
  readonly info: ExitInfo;
  quiet: TimerHandle;
  readonly hard: TimerHandle;
}

export function createTerminal(deps: TerminalDeps): Terminal {
  const { pty, clock, logger } = deps;
  const ring = createRing();
  /** One stream per connection (M8R58); stream ids repeat across connections, so the connection is the key. */
  const attached = new Map<string, Attached>();
  const createdAt = clock.now();
  let lastOutputAt = createdAt;
  let cols = clampSize(deps.cols, PTY_COLS);
  let rows = clampSize(deps.rows, PTY_ROWS);
  let status: "running" | "exited" = "running";
  let exit: ExitInfo | null = null;
  let ptyPaused = false;
  let closing: Promise<void> | null = null;
  let finishing: Finishing | null = null;
  let reaped = false;
  /** The shell was seen dead while the PTY was paused: it is never paused again. */
  let shellGone = false;
  let poll: TimerHandle | null = null;

  const guarded = (event: string, call: () => void): void => {
    try {
      call();
    } catch (error) {
      logger.error(event, { terminalId: deps.id, err: error });
    }
  };

  const view = (): TerminalState => ({
    id: deps.id,
    cwd: deps.cwd,
    sessionId: deps.sessionId,
    projectId: deps.projectId,
    cols,
    rows,
    status,
    exitCode: exit?.code ?? null,
    signal: exit?.signal ?? null,
    createdAt,
  });

  const info = (streamId: number, start: number): AttachInfo => ({
    streamId,
    start,
    end: ring.end,
    cols,
    rows,
    status,
  });

  const clearPoll = (): void => {
    if (poll) clock.clearTimeout(poll);
    poll = null;
  };

  /** A paused PTY whose shell died would lose its last bytes to node-pty's 200 ms timeout: resume as soon as it is gone. */
  const watchShell = (): void => {
    poll = clock.setTimeout(() => {
      poll = null;
      if (!ptyPaused || closing) return;
      let alive = true;
      guarded("terminal_alive_failed", () => {
        alive = deps.alive();
      });
      if (alive) return watchShell();
      shellGone = true;
      setPtyPaused(false);
    }, ALIVE_POLL_MS);
  };

  const setPtyPaused = (paused: boolean): void => {
    if (paused === ptyPaused) return;
    ptyPaused = paused;
    clearPoll();
    if (paused) watchShell();
    guarded("terminal_pty_flow_failed", () => (paused ? pty.pause() : pty.resume()));
  };

  /** M8R57: the PTY waits only while a committed, non-stale stream exists and every such stream is paused. */
  const reconcile = (): void => {
    if (closing || status === "exited" || finishing || shellGone) return;
    const holders = [...attached.values()]
      .map((entry) => entry.flow)
      .filter((flow) => flow.open && !flow.stale);
    setPtyPaused(holders.length > 0 && holders.every((flow) => flow.paused !== null));
  };

  /** One stream's failure must not skip the others or escape into node-pty's data listener. */
  const pumpAll = (): void => {
    for (const entry of [...attached.values()]) guarded("terminal_stream_failed", () => entry.flow.pump());
  };

  const reapOnce = async (): Promise<void> => {
    if (reaped || !deps.scope) return;
    reaped = true;
    try {
      await deps.scope.reap({ signal: (exit?.signal ?? null) as NodeJS.Signals | null });
    } catch (error) {
      logger.error("terminal_reap_failed", { terminalId: deps.id, err: error });
    }
  };

  const clearFinishing = (): void => {
    if (!finishing) return;
    clock.clearTimeout(finishing.quiet);
    clock.clearTimeout(finishing.hard);
    finishing = null;
  };

  /** Records the exit once no data came for a moment: the exit frame follows the last output byte (M8R58). */
  const finishExit = (): void => {
    const pending = finishing;
    if (!pending || closing) return;
    clearFinishing();
    exit = pending.info;
    status = "exited";
    pumpAll();
    guarded("terminal_changed_failed", () => deps.changed(view()));
    guarded("terminal_exited_failed", () => deps.exited());
    void reapOnce();
  };

  const onExit = (result: ExitInfo): void => {
    if (closing || status === "exited" || finishing) return;
    // A paused PTY would never hand over its last bytes.
    setPtyPaused(false);
    finishing = {
      info: result,
      quiet: clock.setTimeout(finishExit, EXIT_QUIET_MS),
      hard: clock.setTimeout(finishExit, EXIT_WAIT_MAX_MS),
    };
  };

  pty.onData((chunk) => {
    if (closing || status === "exited") return;
    lastOutputAt = clock.now();
    if (finishing) {
      clock.clearTimeout(finishing.quiet);
      finishing.quiet = clock.setTimeout(finishExit, EXIT_QUIET_MS);
    }
    ring.append(chunk);
    pumpAll();
  });
  pty.exited.then(onExit).catch((error: unknown) => {
    logger.error("terminal_exit_failed", { terminalId: deps.id, err: error });
  });

  const release = (entry: Attached): void => {
    if (attached.get(entry.connectionId) === entry) attached.delete(entry.connectionId);
    entry.flow.close();
    reconcile();
  };

  /** Detached here and closed on the channel (`onClose` then finds nothing left to do). */
  const closeStream = (entry: Attached): void => {
    release(entry);
    guarded("terminal_stream_close_failed", () => entry.stream.close());
  };

  const write = (entry: Attached, seq: number, payload: Uint8Array): void => {
    if (status !== "running" || closing || finishing) return;
    if (seq <= entry.lastInput || payload.byteLength > MAX_FRAME_PAYLOAD) return;
    entry.lastInput = seq;
    guarded("terminal_write_failed", () => pty.write(payload));
  };

  const terminal: Terminal = {
    id: deps.id,
    ownerId: deps.ownerId,
    cwd: deps.cwd,
    sessionId: deps.sessionId,
    createdAt,
    view,
    activity: () => ({ streams: attached.size, lastOutputAt }),
    streamOf(connectionId) {
      const entry = attached.get(connectionId);
      return entry ? info(entry.flow.streamId, entry.flow.next) : null;
    },
    attach(connectionId, open, after) {
      const existing = terminal.streamOf(connectionId);
      if (existing) return existing;
      if (closing) throw new PapError("not_found");
      if (attached.size >= MAX_STREAMS_PER_TERMINAL) throw new PapError("capacity");
      const safe = ring.safeStart();
      const continues =
        after !== undefined && Number.isSafeInteger(after) && after >= safe && after <= ring.end;
      let entry: Attached | null = null;
      const sink: BinarySink = {
        onOpen: () => {
          entry?.flow.commit();
          // A stream that just opened joins the ones that hold the PTY, paused or not.
          reconcile();
        },
        onInput: (seq, payload) => {
          if (entry && attached.get(entry.connectionId) === entry) write(entry, seq, payload);
        },
        onAck: (offset) => entry?.flow.ack(offset),
        onClose: () => {
          if (entry) release(entry);
        },
      };
      const stream = open(sink);
      const flow = createFlow({
        stream,
        ring,
        clock,
        exit: () => exit,
        changed: reconcile,
        from: continues ? after : undefined,
      });
      entry = { connectionId, stream, flow, lastInput: 0 };
      attached.set(connectionId, entry);
      return info(stream.streamId, continues ? after : safe);
    },
    detach(connectionId, streamId) {
      const entry = attached.get(connectionId);
      if (entry?.stream.streamId !== streamId) return;
      closeStream(entry);
    },
    resize(nextCols, nextRows) {
      if (status !== "running" || closing) return;
      cols = clampSize(nextCols, PTY_COLS);
      rows = clampSize(nextRows, PTY_ROWS);
      guarded("terminal_resize_failed", () => pty.resize(cols, rows));
      guarded("terminal_changed_failed", () => deps.changed(view()));
    },
    close() {
      closing ??= (async () => {
        clearFinishing();
        clearPoll();
        const wasRunning = status === "running";
        if (wasRunning) {
          try {
            await deps.kill({ pid: pty.pid, start: pty.start, exited: pty.exited });
          } catch (error) {
            logger.error("terminal_kill_failed", { terminalId: deps.id, err: error });
          }
        }
        await reapOnce();
        for (const entry of [...attached.values()]) closeStream(entry);
        guarded("terminal_closed_failed", () => deps.closed());
      })();
      return closing;
    },
  };
  return terminal;
}
