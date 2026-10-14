import { MAX_FRAME_PAYLOAD, type BinaryStream } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Ring } from "./ring.ts";

/** A stream is sent at most this far past its last ack (M8R57). */
export const FLOW_WINDOW_BYTES = 512 * 1024;
/** A window-paused stream resumes when an ack brings its lag to this or less. */
export const FLOW_RESUME_BYTES = 256 * 1024;
/** A socket that refused a frame is tried again at this interval. */
export const FLOW_RETRY_MS = 50;
/** A stream paused this long is stale: still attached, no longer holding the PTY (a background tab, owner f2). */
export const FLOW_STALE_MS = 2000;

export type PauseReason = "window" | "buffer";

export interface ExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface FlowDeps {
  readonly stream: BinaryStream;
  readonly ring: Ring;
  readonly clock: Clock;
  /** Set once the terminal recorded the shell's exit: sent after the last output byte. */
  exit(): ExitInfo | null;
  /** The pause or stale state changed: the terminal decides again whether the PTY runs. */
  changed(): void;
  /** `undefined`: the first frame is `reset` and the ring; a number: continue from this offset. */
  readonly from: number | undefined;
}

export interface Flow {
  readonly streamId: number;
  /** Committed (the answer went out), not closed. */
  readonly open: boolean;
  readonly next: number;
  readonly paused: PauseReason | null;
  readonly stale: boolean;
  commit(): void;
  /** New output or a recorded exit: send what can go. */
  pump(): void;
  ack(offset: number): void;
  close(): void;
}

const encodeExit = (exit: ExitInfo): Uint8Array => new TextEncoder().encode(JSON.stringify(exit));

/** One attached stream's sender: offsets, the ack window, the socket-buffer retry and the stale state (M8R57, M8R58). */
export function createFlow(deps: FlowDeps): Flow {
  const { stream, ring, clock } = deps;
  let state: "prepared" | "open" | "closed" = "prepared";
  let next = deps.from ?? 0;
  let acked = next;
  let needsReset = deps.from === undefined;
  let exitSent = false;
  let paused: PauseReason | null = null;
  let stale = false;
  let staleTimer: TimerHandle | null = null;
  let retryTimer: TimerHandle | null = null;

  const clearStale = (): void => {
    if (staleTimer) clock.clearTimeout(staleTimer);
    staleTimer = null;
  };
  const clearRetry = (): void => {
    if (retryTimer) clock.clearTimeout(retryTimer);
    retryTimer = null;
  };
  const armStale = (): void => {
    clearStale();
    staleTimer = clock.setTimeout(() => {
      staleTimer = null;
      if (paused === null || state === "closed") return;
      stale = true;
      deps.changed();
    }, FLOW_STALE_MS);
  };

  /** Moves to `reason`. The 2 s count starts when the pause starts and only a resume ends it (M8R57, MC27). */
  const setPaused = (reason: PauseReason | null): void => {
    if (reason === null) {
      paused = null;
      stale = false;
      clearStale();
      clearRetry();
    } else {
      if (paused === null) {
        stale = false;
        armStale();
      }
      paused = reason;
      if (reason === "window") clearRetry();
      else if (retryTimer === null) retryTimer = clock.setTimeout(retry, FLOW_RETRY_MS);
    }
  };

  /** Runs a change and tells the terminal once, and only when the pause or stale state moved. */
  const settle = (change: () => void): void => {
    const before = { paused, stale };
    change();
    if (before.paused !== paused || before.stale !== stale) deps.changed();
  };

  function retry(): void {
    retryTimer = null;
    if (state === "open" && paused === "buffer") settle(attempt);
  }

  /** Sends until the ring is drained, the window is full or the socket refuses. */
  function attempt(): void {
    const blocked = (reason: PauseReason): void => setPaused(reason);
    for (;;) {
      if (needsReset || next < ring.start) {
        const at = ring.safeStart();
        if (!stream.send("reset", at, new Uint8Array(0))) return blocked("buffer");
        next = at;
        acked = at;
        needsReset = false;
      }
      if (next >= ring.end) break;
      const room = FLOW_WINDOW_BYTES - (next - acked);
      if (room <= 0) return blocked("window");
      const chunk = ring.read(next, Math.min(MAX_FRAME_PAYLOAD, room));
      if (!stream.send("output", next, chunk)) return blocked("buffer");
      next += chunk.byteLength;
    }
    const exit = deps.exit();
    if (exit && !exitSent) {
      if (!stream.send("exit", ring.end, encodeExit(exit))) return blocked("buffer");
      exitSent = true;
    }
    setPaused(null);
  }

  return {
    streamId: stream.streamId,
    get open() {
      return state === "open";
    },
    get next() {
      return next;
    },
    get paused() {
      return paused;
    },
    get stale() {
      return stale;
    },
    commit() {
      if (state !== "prepared") return;
      state = "open";
      settle(attempt);
    },
    pump() {
      if (state === "open" && paused === null) settle(attempt);
    },
    ack(offset) {
      // An ack that moves nothing is no news. One that does not resume the stream only advances `acked`: the 2 s
      // of a pause are not restarted by it (a hidden tab acking now and then must not hold the PTY, owner f2).
      if (state !== "open" || !Number.isSafeInteger(offset) || offset <= acked || offset > next) return;
      acked = offset;
      settle(() => {
        if (paused === "window" && next - acked <= FLOW_RESUME_BYTES) {
          paused = null;
          attempt();
        }
      });
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      clearStale();
      clearRetry();
      stale = false;
      paused = null;
    },
  };
}
