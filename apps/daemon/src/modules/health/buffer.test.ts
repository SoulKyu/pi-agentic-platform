import { expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { createLogger, type Logger } from "../../kernel/logger.ts";
import { createHealthBuffer, type HealthChange } from "./buffer.ts";
import type { HealthEventInput } from "./events.ts";

/** The bed logger (automation/testing/bed.ts): every line parsed, so a test can assert what was logged. */
function loggerOf(clock: FakeClock): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    logger: createLogger({
      level: "debug",
      clock,
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    lines,
  };
}

const input = (overrides: Partial<HealthEventInput> = {}): HealthEventInput => ({
  ownerId: "u1",
  kind: "feed",
  code: "not_a_feed",
  sourceRef: { kind: "trigger", id: "t1", name: "k8s blog" },
  ...overrides,
});

it("inserts newest first, seq from 1, and collapses the same identity", async () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  buffer.record(input());
  expect(buffer.page("u1").events).toEqual([
    {
      seq: 1,
      ts: 1_000,
      kind: "feed",
      severity: "err",
      code: "not_a_feed",
      sourceRef: input().sourceRef,
      count: 1,
    },
  ]);
  await clock.advance(5_000);
  buffer.record(input());
  const page = buffer.page("u1");
  expect(page.events).toHaveLength(1);
  expect(page.events[0]).toMatchObject({ seq: 1, ts: 6_000, count: 2, severity: "err" });
  buffer.record(input({ code: "feed_network" }));
  const after = buffer.page("u1").events;
  expect(after).toHaveLength(2); // a different identity inserts
  expect(after.map((event) => event.seq)).toEqual([2, 1]); // newest first
});

it("pages by seq with hasMore and cuts to the frame budget", () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  for (const code of ["feed_address", "feed_redirects", "feed_too_large"]) buffer.record(input({ code }));
  const page = buffer.page("u1", undefined, 2);
  expect(page.events.map((event) => event.seq)).toEqual([3, 2]);
  expect(page.hasMore).toBe(true);
  const older = buffer.page("u1", page.events[1]?.seq);
  expect(older.events.map((event) => event.seq)).toEqual([1]);
  expect(older.hasMore).toBe(false);
});

it("a page stops at the frame budget even under the row limit", () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  // An oversized name on purpose: the buffer sizes what it is given, it never trusts the emitter.
  const name = "x".repeat(9_000);
  for (let id = 1; id <= 120; id++)
    buffer.record(input({ sourceRef: { kind: "trigger", id: `t${id}`, name } }));
  const page = buffer.page("u1", undefined, 200);
  expect(page.events.length).toBeGreaterThan(90);
  expect(page.events.length).toBeLessThan(120);
  expect(page.hasMore).toBe(true);
  expect(sizeOf(page.events)).toBeLessThanOrEqual(PAGE_BYTES);
});

it("the 500 cap drops the oldest and a re-fire inserts a new row", () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  const at = (id: number): HealthEventInput => ({
    ownerId: "u1",
    kind: "task",
    code: "task_failed",
    sourceRef: { kind: "effect", id },
  });
  for (let id = 1; id <= 501; id++) buffer.record(at(id));
  const seen: number[] = [];
  let before: number | undefined;
  for (;;) {
    const page = buffer.page("u1", before, 200);
    seen.push(...page.events.map((event) => event.seq));
    if (!page.hasMore) break;
    const oldest = page.events.at(-1)?.seq;
    if (oldest === undefined) throw new Error("a page with hasMore must hold a row");
    before = oldest;
  }
  expect(seen).toHaveLength(500);
  expect(seen[0]).toBe(501); // seq 501 present
  expect(seen.at(-1)).toBe(2); // seq 1 gone
  buffer.record(at(1)); // re-fire of the dropped identity
  const [refired] = buffer.page("u1").events;
  expect(refired).toMatchObject({ count: 1, sourceRef: { kind: "effect", id: 1 } });
  expect(refired?.seq).toBe(502);
});

it("another owner's page never sees the event", () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  buffer.record(input());
  expect(buffer.page("u2")).toEqual({ events: [], hasMore: false });
});

it("an unknown code is skipped", () => {
  const clock = createFakeClock(1_000);
  const { logger, lines } = loggerOf(clock);
  const buffer = createHealthBuffer({ clock, logger });
  buffer.record(input({ kind: "task", code: "nope" }));
  expect(buffer.page("u1")).toEqual({ events: [], hasMore: false });
  expect(lines).toContainEqual(
    expect.objectContaining({ level: "warn", msg: "health_unknown_code", kind: "task", code: "nope" }),
  );
});

it("a listener that throws is logged and skipped", () => {
  const clock = createFakeClock(1_000);
  const { logger, lines } = loggerOf(clock);
  const buffer = createHealthBuffer({ clock, logger });
  const heard: HealthChange[] = [];
  buffer.on(() => {
    throw new Error("boom");
  });
  buffer.on((change) => void heard.push(change));
  expect(() => buffer.record(input())).not.toThrow();
  expect(heard).toHaveLength(1);
  expect(lines).toContainEqual(expect.objectContaining({ level: "warn", msg: "health_listener_failed" }));
});

it("a fresh instance starts empty at seq 1", () => {
  const clock = createFakeClock(1_000);
  const first = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  for (const code of ["feed_address", "feed_redirects", "feed_too_large"]) first.record(input({ code }));
  const second = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  expect(second.page("u1")).toEqual({ events: [], hasMore: false }); // the restart rule
  second.record(input());
  expect(second.page("u1").events[0]?.seq).toBe(1);
});

it("a listener hears the insert then the collapse, and the unsubscribe stops delivery", async () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  const changes: HealthChange[] = [];
  const off = buffer.on((change) => void changes.push(change));
  buffer.record(input());
  await clock.advance(5_000);
  buffer.record(input());
  off();
  buffer.record(input({ code: "feed_network" }));
  expect(changes).toEqual([
    {
      kind: "event",
      ownerId: "u1",
      event: {
        seq: 1,
        ts: 1_000,
        kind: "feed",
        severity: "err",
        code: "not_a_feed",
        sourceRef: input().sourceRef,
        count: 1,
      },
    },
    { kind: "collapse", ownerId: "u1", seq: 1, ts: 6_000, count: 2 },
  ]);
});

it("snapshot is the page in the client shape", () => {
  const clock = createFakeClock(1_000);
  const buffer = createHealthBuffer({ clock, logger: loggerOf(clock).logger });
  buffer.record(input());
  buffer.record(input({ code: "feed_network" }));
  expect(buffer.snapshot("u1")).toEqual({
    kind: "snapshot",
    ...buffer.page("u1"),
  });
});
