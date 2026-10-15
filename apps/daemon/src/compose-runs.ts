import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { AutomationSettings } from "@pap/contracts";
import type { M10Core } from "./compose-automation.ts";
import type { Outbox } from "./kernel/outbox/index.ts";
import { createMetricsRegistry } from "./kernel/observability/prometheus.ts";
import { createRotatingFile } from "./kernel/observability/rotating-file.ts";
import type { ComposedTrace } from "./compose-trace.ts";
import { automationCollector } from "./modules/automation/index.ts";
import { cleanupAttachments } from "./modules/files/index.ts";
import {
  createRunsModule,
  metricsAuthorized,
  type RunObserver,
  registerRunsMetrics,
  type RunsService,
} from "./modules/runs/index.ts";

export interface ComposedRuns {
  readonly service: RunsService;
  /** What the sessions module is given: inert in read-only mode, where nothing may be written (M10R150). */
  readonly observer: RunObserver;
}

const INERT: RunObserver = { onRecord: () => {}, onEvent: () => {} };

/**
 * The runs registry and its `logs/runs.jsonl` (M10R87). Runs a crash left open are closed before this returns, so they
 * exist as interrupted before the sessions module can open a run (M10R88). Read-only: no recovery, no file, no observer.
 */
export function composeRuns(core: M10Core): ComposedRuns {
  const file = createRotatingFile({ path: join(core.config.home, "logs", "runs.jsonl") });
  const service = createRunsModule({
    db: core.db,
    clock: core.clock,
    logger: core.logger,
    appendLine: (line) => file.append(line),
    observability: {
      metrics: core.config.metricsToken !== null,
      otlpHost: core.config.otlp === null ? null : new URL(core.config.otlp.endpoint).host,
    },
  });
  if (core.readOnly) return { service, observer: INERT };
  const recovered = service.recover();
  if (recovered > 0) core.logger.warn("runs_interrupted_at_boot", { runs: recovered });
  return { service, observer: service.observer };
}

export interface ComposedMetrics {
  /** Late: the families that read other modules (workers, the budget). Nothing here runs before a scrape. */
  bind(modules: {
    readonly settings: {
      automation(ownerId: string): Pick<AutomationSettings, "paused" | "dailyBudgetUsd" | "timezone">;
    };
    readonly workers: () => { used: number; max: number };
  }): void;
  /** `GET /metrics` behind its own bearer; nothing is mounted without `PAP_METRICS_TOKEN` (404 like any reserved path). */
  mount(app: Hono): void;
}

/** The registry and its route (M10R95, M10R96). The families of the kernel and of the runs table are registered here. */
export function composeMetrics(core: M10Core, runs: RunsService, trace: ComposedTrace): ComposedMetrics {
  const { clock, config } = core;
  const registry = createMetricsRegistry({ clock, logger: core.logger });
  registerRunsMetrics(registry, { db: core.db, clock });
  registry.counter(
    "pap_event_loop_stall_seconds_total",
    "Seconds the event loop stalled, over the stalls counted (more than 2 s).",
    [],
    () => [{ value: trace.stall.counters().totalStallMs / 1000 }],
  );
  registry.gauge("pap_event_loop_delay_max_seconds", "The longest event loop stall counted.", [], () => [
    { value: trace.stall.counters().maxStallMs / 1000 },
  ]);
  registry.counter(
    "pap_otlp_dropped_spans_total",
    "Spans lost: refused by the tracer or its local file, or dropped by the OTLP export (queue full, failed or timed-out send).",
    [],
    () => [{ value: trace.dropped() }],
  );
  trace.exporter?.useMetrics(async () => {
    await registry.collect();
    return registry.snapshot();
  });
  registry.gauge("process_resident_memory_bytes", "Resident memory of the daemon.", [], () => [
    { value: process.memoryUsage.rss() },
  ]);
  const startedAt = Math.floor(clock.now() / 1000 - process.uptime());
  registry.gauge("process_start_time_seconds", "Start time of the daemon, Unix seconds.", [], () => [
    { value: startedAt },
  ]);
  registry.gauge("pap_workers_max", "Workers the daemon may run at once.", [], () => [
    { value: config.maxWorkers },
  ]);
  return {
    bind({ settings, workers }) {
      registry.gauge("pap_workers_active", "Workers up or starting.", [], () => [{ value: workers().used }]);
      automationCollector(core.db, runs.port, settings)(registry);
    },
    mount(app) {
      const token = config.metricsToken;
      if (token === null) return;
      app.get("/metrics", async (c) => {
        if (!metricsAuthorized(c.req.header("authorization"), token))
          return c.json({ error: { code: "unauthenticated" } }, 401, {
            "WWW-Authenticate": "Bearer",
            "Cache-Control": "no-store",
          });
        return c.body(await registry.collect(), 200, {
          "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
          "Cache-Control": "no-store",
        });
      });
    },
  };
}

const ATTACHMENTS_IDLE_MS = 30 * 86_400_000;
const CLEANUP_NEXT_PASS_MS = 60_000;

/** The newest mtime of a session folder and of the files in it; `Infinity` when unreadable, so the folder is kept. */
function lastTouchedMs(folder: string): number {
  try {
    return readdirSync(folder).reduce(
      (newest, name) => Math.max(newest, lstatSync(join(folder, name)).mtimeMs),
      lstatSync(folder).mtimeMs,
    );
  } catch {
    return Infinity;
  }
}

/**
 * The `attachment.cleanup` handler (M10R102): `$PAP_HOME/attachments/<session id>/` goes when its session was last active
 * more than 30 days ago, or has no row and the folder itself is that old. A pass removes 50 folders at most; while more
 * remain the effect defers a minute (not an attempt) and runs again. Housekeeping enqueues it once a day.
 */
export function registerAttachmentCleanup(
  core: M10Core,
  outbox: Pick<Outbox, "register">,
  sessions: { lastActivityAt(sessionId: string): number | null },
): void {
  const { clock, logger } = core;
  const root = join(core.config.home, "attachments");
  outbox.register("attachment.cleanup", async () => {
    const cutoff = clock.now() - ATTACHMENTS_IDLE_MS;
    const expired = (sessionId: string): boolean => {
      const activeAt = sessions.lastActivityAt(sessionId);
      // A copy into a long idle session lands before its `updated_at` moves: a file under 30 days old keeps the folder.
      return (activeAt === null || activeAt < cutoff) && lastTouchedMs(join(root, sessionId)) < cutoff;
    };
    const { removed, kept, more } = await cleanupAttachments(root, expired);
    logger.info("attachments_cleanup", { removed, kept });
    return more ? { outcome: "defer", until: clock.now() + CLEANUP_NEXT_PASS_MS } : { outcome: "done" };
  });
}
