import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import type { Clock, TimerHandle } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { guardTimer } from "../timer-guard.ts";
import type { Tracer } from "./tracer.ts";

export const SAMPLE_EVERY_MS = 30_000;
/** The histogram's resolution: a delay max is that much above the real stall (T3's numbers). */
const RESOLUTION_MS = 1000;
const STALL_OVER_MS = 2000;
const LOG_EVERY_MS = 60_000;

/** What one interval looked like: the longest loop delay (ns) and the time the loop spent busy (ms). */
export interface LoopReading {
  readonly delayMaxNs: number;
  readonly activeMs: number;
}

export interface LoopSampler {
  /** Reads and resets. */
  sample(): LoopReading;
  stop(): void;
}

/** The real sampler: `monitorEventLoopDelay` and the event loop utilisation. Tests inject a `LoopSampler` instead. */
export function createLoopSampler(): LoopSampler {
  const histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  histogram.enable();
  let last = performance.eventLoopUtilization();
  return {
    sample() {
      const now = performance.eventLoopUtilization();
      const { active } = performance.eventLoopUtilization(now, last);
      last = now;
      const delayMaxNs = histogram.max;
      histogram.reset();
      return {
        delayMaxNs: Number.isFinite(delayMaxNs) ? delayMaxNs : 0,
        activeMs: Number.isFinite(active) ? active : 0,
      };
    },
    stop: () => void histogram.disable(),
  };
}

export interface StallCounters {
  readonly stalls: number;
  readonly lastStallMs: number;
  readonly maxStallMs: number;
  /** Every stall's length added up since the start: a counter (`pap_event_loop_stall_seconds_total`). */
  readonly totalStallMs: number;
}

export interface StallMonitor {
  start(): void;
  stop(): void;
  /** What Task 14 exposes. They run in read-only mode too. */
  counters(): StallCounters;
}

/**
 * Samples the loop every 30 s on the Clock (M10R93). A sample whose delay max minus the resolution exceeds 2 s, while
 * the loop was busy at least that long, is a stall; a delay with no activity is a suspended machine and counts for
 * nothing. A stall is counted, traced as `event_loop.stall` and logged as `event_loop_stall {ms}` once a minute.
 */
export function createStallMonitor(options: {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly tracer: Tracer;
  readonly sampler?: LoopSampler;
}): StallMonitor {
  const { clock, logger, tracer } = options;
  let sampler = options.sampler ?? null;
  let timer: TimerHandle | null = null;
  let running = false;
  let loggedAt: number | null = null;
  let stalls = 0;
  let lastStallMs = 0;
  let maxStallMs = 0;
  let totalStallMs = 0;

  function observe(): void {
    if (!sampler) return;
    const { delayMaxNs, activeMs } = sampler.sample();
    const stallMs = Math.round(delayMaxNs / 1e6 - RESOLUTION_MS);
    if (stallMs <= STALL_OVER_MS || activeMs < stallMs) return;
    const at = clock.now();
    stalls++;
    lastStallMs = stallMs;
    maxStallMs = Math.max(maxStallMs, stallMs);
    totalStallMs += stallMs;
    tracer.record("event_loop.stall", { start: at - stallMs, durationMs: stallMs });
    if (loggedAt !== null && at - loggedAt < LOG_EVERY_MS) return;
    loggedAt = at;
    logger.warn("event_loop_stall", { ms: stallMs });
  }

  function arm(): void {
    if (!running) return;
    timer = clock.setTimeout(() => {
      timer = null;
      void guardTimer(logger, "event_loop_sample", observe, clock).finally(arm);
    }, SAMPLE_EVERY_MS);
  }

  return {
    start() {
      if (running) return;
      running = true;
      sampler ??= createLoopSampler();
      arm();
    },
    stop() {
      running = false;
      if (timer) clock.clearTimeout(timer);
      timer = null;
      sampler?.stop();
    },
    counters: () => ({ stalls, lastStallMs, maxStallMs, totalStallMs }),
  };
}
