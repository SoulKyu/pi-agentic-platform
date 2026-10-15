import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import type { OtlpConfig } from "../config.ts";
import type { Logger } from "../logger.ts";
import { createExporter, type OtlpTransport } from "./otlp.ts";
import type { ExportedSpan } from "./tracer.ts";

const SECRET = "super-secret-header-value";
const config: OtlpConfig = {
  endpoint: "https://otel.example/base",
  serviceName: "pap",
  headers: () => ({ "x-key": SECRET }),
};

const span = (n: number): ExportedSpan => ({
  name: "scheduler.tick",
  start: 1_000 + n,
  durationMs: 1,
  outcome: "ok",
  attrs: { count: n },
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal;
}

function setup(answer: (sent: Sent) => Promise<number> = () => Promise.resolve(200)) {
  const clock = createFakeClock();
  const sent: Sent[] = [];
  const logs: Array<{ msg: string; fields: unknown }> = [];
  const record = (msg: string, fields?: unknown) => void logs.push({ msg, fields });
  const logger: Logger = {
    debug: record,
    info: record,
    warn: record,
    error: record,
    child: () => logger,
  };
  const transport: OtlpTransport = (request) => {
    const entry = { ...request };
    sent.push(entry);
    return answer(entry);
  };
  const exporter = createExporter({ config, clock, logger, transport, randomHex: (b) => "a".repeat(b * 2) });
  if (!exporter) throw new Error("no exporter");
  const spansOf = (call: Sent): number =>
    (JSON.parse(call.body) as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> })
      .resourceSpans[0]?.scopeSpans[0]?.spans.length ?? -1;
  return { clock, sent, logs, exporter, spansOf };
}

const never = (): Promise<number> => new Promise(() => {});

describe("createExporter", () => {
  it("is null without a configuration, and no timer is pending", () => {
    const clock = createFakeClock();
    const silent: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => silent };
    expect(createExporter({ config: null, clock, logger: silent })).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it("arms nothing before start() and posts nothing when the queue is empty", async () => {
    const { clock, sent, exporter } = setup();
    expect(clock.pending()).toBe(0);
    exporter.start();
    await clock.advance(10_000);
    expect(sent).toEqual([]);
  });

  it("posts batches of 512 spans every 10 s, to <endpoint>/v1/traces with the configured header", async () => {
    const { clock, sent, exporter, spansOf } = setup();
    exporter.start();
    for (let i = 0; i < 1100; i++) exporter.enqueue(span(i));
    await clock.advance(9_999);
    expect(sent).toHaveLength(0);
    await clock.advance(1);
    expect(sent.map(spansOf)).toEqual([512]);
    await clock.advance(10_000);
    await clock.advance(10_000);
    expect(sent.map(spansOf)).toEqual([512, 512, 76]);
    expect(sent[0]?.url).toBe("https://otel.example/base/v1/traces");
    expect(sent[0]?.headers).toEqual({ "x-key": SECRET, "content-type": "application/json" });
    expect(exporter.dropped()).toBe(0);
  });

  it("keeps 2048 of 3000 spans and counts the 952 refused", async () => {
    const { clock, sent, exporter, spansOf } = setup();
    exporter.start();
    for (let i = 0; i < 3000; i++) exporter.enqueue(span(i));
    expect(exporter.dropped()).toBe(952);
    for (let i = 0; i < 5; i++) await clock.advance(10_000);
    expect(sent.map(spansOf)).toEqual([512, 512, 512, 512]);
    expect(exporter.dropped()).toBe(952);
  });

  it("abandons a transport that never answers at 10 s, counts the batch and sends the next one", async () => {
    const { clock, sent, logs, exporter } = setup(never);
    exporter.start();
    for (let i = 0; i < 3; i++) exporter.enqueue(span(i));
    await clock.advance(10_000);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.signal.aborted).toBe(false);
    await clock.advance(9_999);
    expect(sent[0]?.signal.aborted).toBe(false);
    await clock.advance(1);
    expect(sent[0]?.signal.aborted).toBe(true);
    expect(exporter.dropped()).toBe(3);
    expect(logs).toEqual([
      { msg: "otlp_export_failed", fields: { signal: "traces", status: "timeout", suppressed: 0 } },
    ]);
    exporter.enqueue(span(9));
    await clock.advance(10_000);
    expect(sent).toHaveLength(2);
  });

  it("logs a 500 with the signal and the status only, never a header value, and at most once a minute", async () => {
    const { clock, logs, exporter } = setup(() => Promise.resolve(500));
    exporter.start();
    for (let i = 0; i < 4; i++) {
      exporter.enqueue(span(i));
      await clock.advance(10_000);
    }
    expect(logs).toEqual([
      { msg: "otlp_export_failed", fields: { signal: "traces", status: 500, suppressed: 0 } },
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(exporter.dropped()).toBe(4);
  });

  it("treats a redirect and a thrown transport as failures, and logs neither the error text nor a header", async () => {
    let n = 0;
    const { clock, logs, exporter } = setup(() =>
      ++n === 1 ? Promise.resolve(302) : Promise.reject(new Error(`connect failed ${SECRET}`)),
    );
    exporter.start();
    exporter.enqueue(span(1));
    await clock.advance(10_000);
    await clock.advance(60_000);
    exporter.enqueue(span(2));
    await clock.advance(10_000);
    expect(logs.map((l) => l.fields)).toEqual([
      { signal: "traces", status: 302, suppressed: 0 },
      { signal: "traces", status: "error", suppressed: 0 },
    ]);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
    expect(exporter.dropped()).toBe(2);
  });

  it("posts the metrics snapshot to <endpoint>/v1/metrics every 60 s", async () => {
    const { clock, sent, exporter } = setup();
    exporter.useMetrics(() =>
      Promise.resolve([
        { name: "pap_workers_active", type: "gauge", help: "w", samples: [{ labels: {}, value: 1 }] },
      ]),
    );
    exporter.start();
    await clock.advance(59_999);
    expect(sent).toHaveLength(0);
    await clock.advance(1);
    expect(sent.map((s) => s.url)).toEqual(["https://otel.example/base/v1/metrics"]);
    expect(sent[0]?.body).toContain("pap_workers_active");
    expect(sent[0]?.headers["x-key"]).toBe(SECRET);
    await clock.advance(60_000);
    expect(sent).toHaveLength(2);
  });

  it("logs a failed metrics export under its own signal, and a metrics reader that throws never escapes", async () => {
    const { clock, sent, logs, exporter } = setup(() => Promise.resolve(503));
    exporter.useMetrics(() =>
      Promise.resolve([{ name: "m", type: "gauge", help: "h", samples: [{ labels: {}, value: 1 }] }]),
    );
    exporter.start();
    await clock.advance(60_000);
    expect(sent).toHaveLength(1);
    expect(logs.map((l) => l.fields)).toEqual([{ signal: "metrics", status: 503, suppressed: 0 }]);
    exporter.useMetrics(() => Promise.reject(new Error(SECRET)));
    await clock.advance(60_000);
    expect(sent).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain(SECRET);
  });

  it("flushes the queue once on close, then ignores spans and leaves no timer", async () => {
    const { clock, sent, exporter, spansOf } = setup();
    exporter.start();
    for (let i = 0; i < 700; i++) exporter.enqueue(span(i));
    await exporter.close();
    expect(sent.map(spansOf)).toEqual([512, 188]);
    expect(clock.pending()).toBe(0);
    exporter.enqueue(span(1));
    await clock.advance(120_000);
    expect(sent).toHaveLength(2);
    await exporter.close();
    expect(sent).toHaveLength(2);
  });

  it("gives up the flush after 2 s when the collector never answers, and aborts the send", async () => {
    const { clock, sent, exporter } = setup(never);
    exporter.start();
    exporter.enqueue(span(1));
    let closed = false;
    const closing = exporter.close().then(() => (closed = true));
    await clock.advance(1_999);
    expect(closed).toBe(false);
    await clock.advance(1);
    await closing;
    expect(closed).toBe(true);
    expect(sent[0]?.signal.aborted).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it("aborts a send in flight when it closes", async () => {
    const { clock, sent, exporter } = setup(never);
    exporter.start();
    exporter.enqueue(span(1));
    await clock.advance(10_000);
    expect(sent[0]?.signal.aborted).toBe(false);
    await exporter.close();
    expect(sent[0]?.signal.aborted).toBe(true);
  });
});
