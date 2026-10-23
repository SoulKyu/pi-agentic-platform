import type { OpsStreamEvent } from "@pap/contracts";
import { expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { createLogger, type Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createHealthBuffer } from "./buffer.ts";
import type { HealthEventInput } from "./events.ts";
import { createHealthStream } from "./stream.ts";

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

function bed() {
  const clock = createFakeClock(1_000);
  const { logger, lines } = loggerOf(clock);
  const buffer = createHealthBuffer({ clock, logger });
  const published: Array<{ key: string; event: OpsStreamEvent }> = [];
  const providers = new Map<string, (key: string) => unknown>();
  const hub: Pick<StreamHub, "publish" | "registerSnapshot"> = {
    registerSnapshot: vi.fn((stream, provider) => void providers.set(stream, provider)),
    publish: vi.fn((_stream, key, event) => void published.push({ key, event })),
  };
  const stream = createHealthStream({ buffer, hub, logger });
  return { clock, buffer, hub, published, providers, stream, lines };
}

it("registers the ops snapshot and returns the newest page with hasMore", async () => {
  const { clock, buffer, providers, stream } = bed();
  expect(providers.size).toBe(1);
  buffer.record(input());
  await clock.advance(1);
  buffer.record(input({ code: "feed_network" }));
  const snap = providers.get("ops");
  expect(snap).toBeTypeOf("function");
  expect(snap?.("u1")).toEqual({
    kind: "snapshot",
    hasMore: false,
    events: [
      expect.objectContaining({ seq: 2, code: "feed_network" }),
      expect.objectContaining({ seq: 1, code: "not_a_feed" }),
    ],
  });
  expect(snap?.("u2")).toEqual({ kind: "snapshot", events: [], hasMore: false });
  stream.stop();
});

it("publishes the event, then the collapse delta, keyed by owner", async () => {
  const { clock, buffer, published, stream } = bed();
  buffer.record(input());
  await clock.advance(5_000);
  buffer.record(input({ code: "feed_network" }));
  await clock.advance(5_000);
  buffer.record(input()); // the same identity again: a collapse, not a second row
  expect(published).toHaveLength(3);
  expect(published.every((sent) => sent.key === "u1")).toBe(true);
  expect(published[0]?.event).toEqual({
    kind: "event",
    event: expect.objectContaining({ seq: 1, count: 1 }),
  });
  expect(published[1]?.event).toEqual({ kind: "event", event: expect.objectContaining({ seq: 2 }) });
  expect(published[2]?.event).toEqual({ kind: "collapse", seq: 1, ts: 11_000, count: 2 });
  stream.stop();
});

it("publishes nothing to another owner's key", () => {
  const { buffer, published, stream } = bed();
  buffer.record(input({ ownerId: "u2" }));
  expect(published).toHaveLength(1);
  expect(published[0]?.key).toBe("u2");
  stream.stop();
});

it("logs and skips a publish that throws", () => {
  const clock = createFakeClock(1_000);
  const { logger, lines } = loggerOf(clock);
  const buffer = createHealthBuffer({ clock, logger });
  const hub: Pick<StreamHub, "publish" | "registerSnapshot"> = {
    registerSnapshot: vi.fn(),
    publish: vi.fn(() => {
      throw new Error("boom");
    }),
  };
  const stream = createHealthStream({ buffer, hub, logger });
  expect(() => buffer.record(input())).not.toThrow();
  expect(lines).toContainEqual(expect.objectContaining({ level: "warn", msg: "health_publish_failed" }));
  stream.stop();
});

it("stops publishing after stop", () => {
  const { buffer, published, stream } = bed();
  stream.stop();
  buffer.record(input());
  expect(published).toHaveLength(0);
});
