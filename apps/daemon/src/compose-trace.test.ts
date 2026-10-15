import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { composeM10Early } from "./compose-m10.ts";
import { composeTrace } from "./compose-trace.ts";
import { enqueueEffect } from "./kernel/outbox/store.ts";
import type { OtlpConfig } from "./kernel/config.ts";
import { openM10Core, type M10TestCore } from "./testing/m10-core.ts";

let open: M10TestCore | undefined;
afterEach(() => {
  open?.close();
  open = undefined;
});

const traceLines = (test: M10TestCore): Array<Record<string, unknown>> =>
  readFileSync(join(test.core.config.home, "logs", "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe("composeTrace", () => {
  it("writes spans to logs/trace.jsonl in a 0600 file", () => {
    open = openM10Core();
    mkdirSync(join(open.core.config.home, "logs"), { recursive: true });
    const trace = composeTrace(open.core);
    trace.onCall("sessions.list", 5, "ok");
    trace.close();
    const path = join(open.core.config.home, "logs", "trace.jsonl");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(traceLines(open)).toMatchObject([{ name: "rpc.sessions.list", durationMs: 5, outcome: "ok" }]);
  });

  it("opens no file in read-only mode, and the counters still exist", () => {
    open = openM10Core(true);
    mkdirSync(join(open.core.config.home, "logs"), { recursive: true });
    const trace = composeTrace(open.core);
    trace.onCall("sessions.list", 5, "ok");
    trace.close();
    expect(existsSync(join(open.core.config.home, "logs", "trace.jsonl"))).toBe(false);
    expect(trace.stall.counters().stalls).toBe(0);
  });

  it("gives the outbox a span per handler call, ok or failed", async () => {
    open = openM10Core();
    mkdirSync(join(open.core.config.home, "logs"), { recursive: true });
    const early = composeM10Early(open.core);
    let calls = 0;
    early.outbox.register("task.start", async () => {
      calls++;
      return calls === 1 ? { outcome: "done" } : { outcome: "fail", code: "x" };
    });
    const { db, clock } = open.bed;
    for (const taskId of ["t1", "t2"])
      enqueueEffect(db, { kind: "task.start", ownerId: "u1", payload: { taskId } }, clock.now());
    await early.outbox.drain();
    early.trace.close();
    expect(traceLines(open).map((line) => [line.name, line.outcome])).toEqual([
      ["outbox.task.start", "ok"],
      ["outbox.task.start", "error"],
    ]);
  });
});

describe("composeTrace and the OTLP exporter", () => {
  const otlp: OtlpConfig = { endpoint: "http://127.0.0.1:1", serviceName: "pap", headers: () => ({}) };
  const withOtlp = (test: M10TestCore, readOnly = false) => {
    mkdirSync(join(test.core.config.home, "logs"), { recursive: true });
    return { ...test.core, readOnly, config: { ...test.core.config, otlp, metricsToken: "m".repeat(40) } };
  };
  const overflow = (trace: ReturnType<typeof composeTrace>) => {
    for (let i = 0; i < 2_100; i++) trace.tracer.record("scheduler.tick", { start: 1, durationMs: 1 });
    trace.tracer.record("not.a.span" as never, { start: 1, durationMs: 1 });
  };

  it("builds no exporter without an endpoint, and the dropped count is the tracer's alone", () => {
    open = openM10Core();
    mkdirSync(join(open.core.config.home, "logs"), { recursive: true });
    const trace = composeTrace(open.core);
    overflow(trace);
    trace.close();
    expect(trace.exporter).toBeNull();
    expect(trace.dropped()).toBe(1);
  });

  it("builds none in read-only mode, even with an endpoint", () => {
    open = openM10Core();
    const trace = composeTrace(withOtlp(open, true));
    expect(trace.exporter).toBeNull();
    trace.close();
  });

  it("counts the spans the exporter dropped with those the tracer refused, and /metrics says so", async () => {
    open = openM10Core();
    const core = withOtlp(open);
    const early = composeM10Early(core);
    overflow(early.trace);
    expect(early.trace.dropped()).toBe(52 + 1);
    const app = new Hono();
    early.metrics.mount(app);
    const reply = await app.request("/metrics", { headers: { authorization: `Bearer ${"m".repeat(40)}` } });
    const body = await reply.text();
    expect(body).toContain("pap_otlp_dropped_spans_total 53\n");
    expect(body).toContain("dropped by the OTLP export");
    early.trace.close();
  });
});
