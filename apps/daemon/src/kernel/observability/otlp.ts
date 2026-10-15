import { randomBytes } from "node:crypto";
import type { Clock, TimerHandle } from "../clock.ts";
import type { OtlpConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { createRateLimiter } from "../rate-limit.ts";
import { guardTimer } from "../timer-guard.ts";
import { VERSION } from "../version.ts";
import { metricsBody, tracesBody } from "./otlp-json.ts";
import type { MetricSnapshot } from "./prometheus.ts";
import type { ExportedSpan } from "./tracer.ts";

export const QUEUE_MAX = 2_048;
export const BATCH_MAX = 512;
export const TRACES_EVERY_MS = 10_000;
export const METRICS_EVERY_MS = 60_000;
export const REQUEST_TIMEOUT_MS = 10_000;
/** The whole flush at stop, however many batches it takes. */
export const FLUSH_MAX_MS = 2_000;
const LOG_EVERY_MS = 60_000;

export interface OtlpRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  readonly signal: AbortSignal;
}

/** Resolves to the HTTP status; rejects on a network failure or an abort. */
export type OtlpTransport = (request: OtlpRequest) => Promise<number>;

/** A redirect is never followed (M10R99): a 3xx is a failure like any other non-2xx status. */
export const fetchTransport: OtlpTransport = async ({ url, headers, body, signal }) => {
  const response = await fetch(url, { method: "POST", headers, body, signal, redirect: "manual" });
  response.body?.cancel().catch(() => undefined);
  return response.status;
};

export interface Exporter {
  /** A span the tracer accepted. A full queue refuses it and counts it; a closed exporter ignores it. */
  enqueue(span: ExportedSpan): void;
  /** What the metrics tick reads: the `/metrics` snapshot, built fresh. Unset: no metrics are sent. */
  useMetrics(read: () => Promise<MetricSnapshot>): void;
  /** Arms the two timers. */
  start(): void;
  /** Spans lost so far: queue full, a failed or timed-out send, or left over when the flush ran out of time. */
  dropped(): number;
  /** Stops the timers, abandons what is in flight, then flushes the queue once, within `FLUSH_MAX_MS`. Never rejects. */
  close(): Promise<void>;
}

/**
 * The opt-in OTLP/HTTP JSON exporter (M10R98, M10R99). Null without a configuration: no object, no timer. Nothing here
 * blocks: the queue is bounded, every request has a deadline, no send is retried before the next interval, and a failure
 * logs the signal and the status only (never a header, a URL or an error text).
 */
export function createExporter(options: {
  readonly config: OtlpConfig | null;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly transport?: OtlpTransport;
  readonly randomHex?: (bytes: number) => string;
  readonly version?: string;
}): Exporter | null {
  const { clock, logger } = options;
  if (options.config === null) return null;
  const config: OtlpConfig = options.config;
  const transport = options.transport ?? fetchTransport;
  const randomHex = options.randomHex ?? ((bytes: number) => randomBytes(bytes).toString("hex"));
  const resource = { serviceName: config.serviceName, serviceVersion: options.version ?? VERSION };
  const startedAt = clock.now();
  const limiter = createRateLimiter(clock, LOG_EVERY_MS);
  const queue: ExportedSpan[] = [];
  const armed = new Set<TimerHandle>();
  const inFlight = new Set<AbortController>();
  let refused = 0;
  let closed = false;
  let closing: Promise<void> | undefined;
  let readMetrics: (() => Promise<MetricSnapshot>) | null = null;

  function failed(signal: "traces" | "metrics", status: number | "timeout" | "error"): void {
    const verdict = limiter.check(signal);
    if (verdict.allowed)
      logger.warn("otlp_export_failed", { signal, status, suppressed: verdict.suppressed });
  }

  async function post(signal: "traces" | "metrics", body: object, budgetMs: number): Promise<boolean> {
    const controller = new AbortController();
    inFlight.add(controller);
    let timer: TimerHandle | undefined;
    const deadline = new Promise<"timeout" | "error">((resolve) => {
      // An abort from `close()` settles the wait too, whether or not the transport honours the signal.
      controller.signal.addEventListener("abort", () => resolve("error"), { once: true });
      timer = clock.setTimeout(() => {
        resolve("timeout");
        controller.abort();
      }, budgetMs);
    });
    // The answer is caught where it is made: a send that loses the race may still reject later.
    const answer = (async () =>
      transport({
        url: `${config.endpoint}/v1/${signal}`,
        headers: { ...config.headers(), "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      }))().catch((): "error" => "error");
    try {
      const status = await Promise.race([answer, deadline]);
      if (typeof status === "number" && status >= 200 && status < 300) return true;
      failed(signal, status);
      return false;
    } finally {
      if (timer) clock.clearTimeout(timer);
      inFlight.delete(controller);
    }
  }

  /** False when the batch was lost; true when it was sent or there was nothing to send. */
  async function sendTraces(budgetMs: number): Promise<boolean> {
    const batch = queue.splice(0, BATCH_MAX);
    if (batch.length === 0) return true;
    const sent = await post("traces", tracesBody(batch, resource, randomHex), budgetMs);
    if (!sent) refused += batch.length;
    return sent;
  }

  async function sendMetrics(): Promise<void> {
    if (readMetrics === null) return;
    let snapshot: MetricSnapshot;
    try {
      snapshot = await readMetrics();
    } catch {
      failed("metrics", "error");
      return;
    }
    await post("metrics", metricsBody(snapshot, resource, clock.now(), startedAt), REQUEST_TIMEOUT_MS);
  }

  function arm(name: string, everyMs: number, work: () => Promise<void>): void {
    const handle = clock.setTimeout(() => {
      armed.delete(handle);
      void guardTimer(logger, name, work, clock).finally(() => {
        if (!closed) arm(name, everyMs, work);
      });
    }, everyMs);
    armed.add(handle);
  }

  async function flush(): Promise<void> {
    const until = clock.now() + FLUSH_MAX_MS;
    while (queue.length > 0) {
      const left = until - clock.now();
      if (left <= 0) break;
      if (!(await sendTraces(left))) break;
    }
    refused += queue.splice(0).length;
  }

  return {
    enqueue(span) {
      if (closed) return;
      if (queue.length >= QUEUE_MAX) refused++;
      else queue.push(span);
    },
    useMetrics(read) {
      readMetrics = read;
    },
    start() {
      if (closed || armed.size > 0) return;
      arm("otlp_traces_export", TRACES_EVERY_MS, async () => void (await sendTraces(REQUEST_TIMEOUT_MS)));
      arm("otlp_metrics_export", METRICS_EVERY_MS, sendMetrics);
    },
    dropped: () => refused,
    close() {
      closing ??= (async () => {
        closed = true;
        for (const handle of armed) clock.clearTimeout(handle);
        armed.clear();
        for (const controller of inFlight) controller.abort();
        await guardTimer(logger, "otlp_flush", flush, clock);
      })();
      return closing;
    },
  };
}
