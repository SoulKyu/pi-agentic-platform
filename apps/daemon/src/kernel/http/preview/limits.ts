import { createHash } from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";
import type { Clock, TimerHandle } from "../../clock.ts";
import type { Logger } from "../../logger.ts";

/** The bounds of the untrusted listener (spec §4). Every cap refuses when full; none evicts. */
export const PREVIEW_LIMITS = Object.freeze({
  /** Live tunnels per box: relayed requests in flight and open WebSockets. */
  tunnelsPerBox: 32,
  /** Tunnel opens of one box in flight to the guest at once (the gateway admits 4 pending connections per VM). */
  opensPerBox: 2,
  /** Opens of one box waiting, first come first served, for one of those places; past it an open is refused `busy`. */
  openWaitersPerBox: 32,
  /** How long an open waits for its place; the open itself then has the guest link's own 15 s (`TUNNEL_OPEN_MS`). */
  openWaitMs: 15_000,
  /** A request body; a declared length above it is refused before a tunnel opens. */
  bodyBytes: 10 * 1024 * 1024,
  /** No byte either way on a relayed connection for this long ends it. */
  idleMs: 120_000,
  /** Sockets the listener holds at once, whatever they ask for. */
  listenerSockets: 256,
  /** From the first byte to the end of the request headers. */
  headersMs: 10_000,
  /** One log line per refusal reason and token in this window. */
  refusalEveryMs: 60_000,
  /** Reason and token pairs the refusal log remembers; past it, new pairs share one line per reason. */
  refusalKeys: 1024,
});

/** A token in a log line: a short hash, never the capability (spec §3, anti-goal). */
export const tokenRef = (token: string | null): string =>
  token === null ? "-" : `t:${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;

export interface BoxSlots {
  /** A place for one tunnel of `box`, or null when the box holds `max` already. Release it once. */
  take(box: string): (() => void) | null;
  count(box: string): number;
}

/** A counter per box: the map holds only boxes with a live tunnel, so it is bounded by the boxes that exist. */
export function createBoxSlots(max: number): BoxSlots {
  const used = new Map<string, number>();
  return {
    take(box) {
      const now = used.get(box) ?? 0;
      if (now >= max) return null;
      used.set(box, now + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (used.get(box) ?? 1) - 1;
        if (left <= 0) used.delete(box);
        else used.set(box, left);
      };
    },
    count: (box) => used.get(box) ?? 0,
  };
}

export class BodyTooLarge extends Error {
  override name = "BodyTooLarge";
}

/** Counts a request body on its way to the tunnel and fails it past `max` bytes (a chunked body has no declared length). */
export function bodyMeter(max: number): Transform & { readonly bytes: () => number } {
  let seen = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, done: TransformCallback) {
      seen += chunk.length;
      if (seen > max) return done(new BodyTooLarge("body over the preview cap"));
      done(null, chunk);
    },
  });
  return Object.assign(meter, { bytes: () => seen });
}

export interface IdleWatch {
  /** Bytes moved: the idle wait starts again. */
  touch(): void;
  stop(): void;
}

/** One timer per connection, re-armed for the remainder when it fires early: a busy connection costs no timer per chunk. */
export function idleWatch(clock: Clock, ms: number, onIdle: () => void): IdleWatch {
  let last = clock.now();
  let timer: TimerHandle | undefined;
  let stopped = false;
  const arm = (delay: number): void => {
    timer = clock.setTimeout(() => {
      timer = undefined;
      if (stopped) return;
      const quiet = clock.now() - last;
      if (quiet >= ms) {
        stopped = true;
        onIdle();
      } else arm(ms - quiet);
    }, delay);
  };
  arm(ms);
  return {
    touch: () => void (last = clock.now()),
    stop() {
      stopped = true;
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}

export type PreviewRefusal =
  "not_found" | "busy" | "too_large" | "box_stopped" | "upstream_failed" | "idle" | "dest_refused";

/**
 * `preview_refused`, at most once per reason and token a minute, with the count it stands for. The token is a hash
 * (`tokenRef`). Pairs are forgotten once their minute is over; while 1024 live pairs are held, a new pair shares the
 * reason's `t:*` line instead of evicting one.
 */
export function createRefusalLog(
  logger: Logger,
  clock: Clock,
): (reason: PreviewRefusal, token: string | null) => void {
  const windows = new Map<string, { at: number; suppressed: number }>();
  return (reason, token) => {
    const now = clock.now();
    if (windows.size >= PREVIEW_LIMITS.refusalKeys)
      for (const [key, window] of windows)
        if (now - window.at >= PREVIEW_LIMITS.refusalEveryMs) windows.delete(key);
    let ref = tokenRef(token);
    if (!windows.has(`${reason}:${ref}`) && windows.size >= PREVIEW_LIMITS.refusalKeys) ref = "t:*";
    const key = `${reason}:${ref}`;
    const window = windows.get(key);
    if (window !== undefined && now - window.at < PREVIEW_LIMITS.refusalEveryMs) {
      window.suppressed++;
      return;
    }
    windows.set(key, { at: now, suppressed: 0 });
    logger.warn("preview_refused", { reason, ref, suppressed: window?.suppressed ?? 0 });
  };
}

export class OpenBusy extends Error {
  override name = "OpenBusy";
}

export interface OpenQueue {
  /**
   * Runs `open` once one of the box's `inFlight` places is free, in arrival order. Rejects `OpenBusy` at once when `waiting`
   * opens of the box already wait, and when its place has not come within `waitMs`; an aborted wait leaves the queue.
   */
  run<T>(box: string, open: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Opens of `box` in flight and waiting: the map holds only boxes with one of either. */
  size(box: string): { inFlight: number; waiting: number };
}

/**
 * Red team I3: a page's CSS, scripts and images arrive at once (a browser opens up to 6 connections), and every relayed request
 * needs a tunnel of its own. Two opens per box go to the guest at a time; the others wait their turn instead of failing. The
 * wait is bounded in count and in time and never evicts one already waiting (refuse when full).
 */
export function createOpenQueue(options: {
  readonly clock: Clock;
  readonly inFlight: number;
  readonly waiting: number;
  readonly waitMs: number;
}): OpenQueue {
  interface Waiter {
    readonly start: () => void;
  }
  const boxes = new Map<string, { running: number; queue: Waiter[] }>();
  const stateOf = (box: string) => {
    let state = boxes.get(box);
    if (state === undefined) {
      state = { running: 0, queue: [] };
      boxes.set(box, state);
    }
    return state;
  };
  const forget = (box: string): void => {
    const state = boxes.get(box);
    if (state !== undefined && state.running === 0 && state.queue.length === 0) boxes.delete(box);
  };
  const leave = (box: string, waiter: Waiter): boolean => {
    const state = boxes.get(box);
    const at = state?.queue.indexOf(waiter) ?? -1;
    if (state === undefined || at < 0) return false;
    state.queue.splice(at, 1);
    forget(box);
    return true;
  };
  const next = (box: string): void => {
    const state = boxes.get(box);
    if (state === undefined) return;
    state.running--;
    const waiter = state.queue.shift();
    if (waiter !== undefined) waiter.start();
    else forget(box);
  };
  return {
    run(box, open, signal) {
      if (signal?.aborted) return Promise.reject(new OpenBusy("aborted"));
      const state = stateOf(box);
      const go = <T>(
        resolve: (value: T) => void,
        reject: (error: unknown) => void,
        task: () => Promise<T>,
      ) => {
        state.running++;
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          next(box);
        };
        // A synchronous throw of `task` is a rejection like any other: its place frees and the caller is answered.
        new Promise<T>((settle) => settle(task())).then(
          (value) => {
            done();
            resolve(value);
          },
          (error: unknown) => {
            done();
            reject(error);
          },
        );
      };
      return new Promise((resolve, reject) => {
        if (state.running < options.inFlight && state.queue.length === 0) return go(resolve, reject, open);
        if (state.queue.length >= options.waiting) {
          forget(box);
          return reject(new OpenBusy("too many opens waiting"));
        }
        let timer: TimerHandle | undefined;
        const onAbort = () => {
          if (timer !== undefined) options.clock.clearTimeout(timer);
          if (leave(box, waiter)) reject(new OpenBusy("aborted"));
        };
        const waiter: Waiter = {
          start: () => {
            if (timer !== undefined) options.clock.clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            go(resolve, reject, open);
          },
        };
        timer = options.clock.setTimeout(() => {
          timer = undefined;
          signal?.removeEventListener("abort", onAbort);
          if (leave(box, waiter)) reject(new OpenBusy("waited too long"));
        }, options.waitMs);
        signal?.addEventListener("abort", onAbort, { once: true });
        state.queue.push(waiter);
      });
    },
    size: (box) => {
      const state = boxes.get(box);
      return { inFlight: state?.running ?? 0, waiting: state?.queue.length ?? 0 };
    },
  };
}
