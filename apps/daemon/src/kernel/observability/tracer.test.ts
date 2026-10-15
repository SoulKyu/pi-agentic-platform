import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createTracer } from "./tracer.ts";

function setup(file: { append(line: string): void } | null = null) {
  const lines: string[] = [];
  const clock = createFakeClock(1_000_000);
  const tracer = createTracer({ clock, file: file ?? { append: (line) => void lines.push(line) } });
  const parsed = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { tracer, clock, lines, parsed };
}

describe("tracer", () => {
  it("writes one line with exactly the five keys", async () => {
    const { tracer, clock, parsed } = setup();
    const span = tracer.span("hook", { verdict: "accepted", bytes: 12 });
    await clock.advance(250);
    span.end("ok");
    expect(parsed()).toEqual([
      {
        name: "hook",
        start: 1_000_000,
        durationMs: 250,
        outcome: "ok",
        attrs: { verdict: "accepted", bytes: 12 },
      },
    ]);
    expect(Object.keys(parsed()[0] ?? {})).toEqual(["name", "start", "durationMs", "outcome", "attrs"]);
  });

  it("keeps an empty attrs object when the span has none", () => {
    const { tracer, parsed } = setup();
    tracer.span("scheduler.tick").end("ok");
    expect(parsed()[0]?.attrs).toEqual({});
  });

  it("drops an attribute key outside the set of its name", () => {
    const { tracer, parsed } = setup();
    tracer.span("scheduler.tick", { count: 2, path: "/home/owner/x", sessionId: "s-1" } as never).end("ok");
    expect(parsed()[0]?.attrs).toEqual({ count: 2 });
  });

  it("turns a method outside the catalogue into rpc.unknown", () => {
    const { tracer, parsed } = setup();
    tracer.span("rpc.sessions.list").end("ok");
    tracer.span("rpc.not.a.method").end("ok");
    tracer.span("rpc.constructor").end("ok");
    expect(parsed().map((line) => line.name)).toEqual(["rpc.sessions.list", "rpc.unknown", "rpc.unknown"]);
  });

  it("refuses a name outside the closed set and counts it", () => {
    const { tracer, lines } = setup();
    tracer.span("owner.secret" as never).end("ok");
    tracer.span("outbox.nope").end("ok");
    expect(lines).toEqual([]);
    expect(tracer.dropped()).toBe(2);
  });

  it("drops a line whose attribute value is 2 KiB and counts it", () => {
    const { tracer, lines } = setup();
    tracer.span("hook", { verdict: "x".repeat(2048) }).end("ok");
    expect(lines).toEqual([]);
    expect(tracer.dropped()).toBe(1);
  });

  it("drops a free text value even when it is short", () => {
    const { tracer, lines } = setup();
    tracer.span("hook", { origin: "my prompt: write to /etc/passwd" }).end("ok");
    expect(lines).toEqual([]);
    expect(tracer.dropped()).toBe(1);
  });

  it("takes the code of a thrown PapError as the outcome", () => {
    const { tracer, parsed } = setup();
    tracer.span("fire").end(new PapError("capacity"));
    tracer.span("fire").end("budget_reached");
    tracer.span("fire").end(new Error("secret text"));
    tracer.span("fire").end("some free text");
    expect(parsed().map((line) => line.outcome)).toEqual(["capacity", "budget_reached", "error", "error"]);
  });

  it("ends a span once", () => {
    const { tracer, lines } = setup();
    const span = tracer.span("run");
    span.end("ok");
    span.end("ok");
    expect(lines).toHaveLength(1);
  });

  it("turns each dispatcher call into an rpc span backdated by its duration", () => {
    const { tracer, parsed } = setup();
    tracer.onCall("sessions.list", 40, "not_found");
    expect(parsed()).toEqual([
      { name: "rpc.sessions.list", start: 999_960, durationMs: 40, outcome: "not_found", attrs: {} },
    ]);
  });

  it("never throws when the file cannot be written, and counts the line", () => {
    const { tracer } = setup({
      append: () => {
        throw new Error("ENOSPC");
      },
    });
    expect(() => tracer.span("run").end("ok")).not.toThrow();
    expect(tracer.dropped()).toBe(1);
  });

  it("writes nothing without a file (read-only mode) and still does not throw", () => {
    const tracer = createTracer({ clock: createFakeClock(), file: null });
    expect(() => tracer.span("run").end("ok")).not.toThrow();
    expect(tracer.dropped()).toBe(0);
  });
});

describe("tracer onSpan", () => {
  it("hands the exporter the closed span, with a null file too, and never an attribute outside the set", () => {
    const seen: unknown[] = [];
    const tracer = createTracer({
      clock: createFakeClock(5_000),
      file: null,
      onSpan: (span) => void seen.push(span),
    });
    tracer.span("hook", { verdict: "accepted", bytes: 3, path: "/home/owner" } as never).end("ok");
    tracer.span("not.a.span" as never).end("ok");
    expect(seen).toEqual([
      { name: "hook", start: 5_000, durationMs: 0, outcome: "ok", attrs: { verdict: "accepted", bytes: 3 } },
    ]);
    expect(tracer.dropped()).toBe(1);
  });

  it("counts a throwing exporter as dropped and still writes the line", () => {
    const lines: string[] = [];
    const tracer = createTracer({
      clock: createFakeClock(),
      file: { append: (line) => void lines.push(line) },
      onSpan: () => {
        throw new Error("boom");
      },
    });
    tracer.span("scheduler.tick").end("ok");
    expect(lines).toHaveLength(1);
    expect(tracer.dropped()).toBe(1);
  });
});
