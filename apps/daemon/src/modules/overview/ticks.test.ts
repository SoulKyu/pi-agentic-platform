import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import { createOverviewTicks, TICK_EVERY_MS } from "./ticks.ts";

function bed() {
  const clock = createFakeClock(10_000);
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  const published: Array<{ stream: string; key: string; event: unknown }> = [];
  const subscribed = new Set<string>();
  const providers = new Map<string, (key: string) => unknown>();
  const left: Array<(key: string) => void> = [];
  const hub: Pick<StreamHub, "publish" | "registerSnapshot" | "hasSubscribers" | "onLastSubscriberLeft"> = {
    registerSnapshot: (stream, provider) => void providers.set(stream, provider),
    publish: (stream, key, event) => void published.push({ stream, key, event }),
    hasSubscribers: (_stream, key) => subscribed.has(key),
    onLastSubscriberLeft: (_stream, listener) => void left.push(listener),
  };
  const ticks = createOverviewTicks({ clock, hub, logger });
  const subscribe = (userId: string) => {
    subscribed.add(userId);
    ticks.open(userId);
  };
  const leave = (userId: string) => {
    subscribed.delete(userId);
    for (const listener of left) listener(userId);
  };
  return { clock, ticks, published, providers, subscribe, leave, lines, subscribed };
}

const countOf = (published: Array<{ key: string }>, key: string) =>
  published.filter((one) => one.key === key).length;

describe("overview ticks (R2, Review Focus 5)", () => {
  it("answers a snapshot with the payload-less tick and publishes on the overview stream", async () => {
    const { providers, ticks, subscribe, published } = bed();
    expect(providers.get("overview")?.("u1")).toEqual({ kind: "changed" });
    subscribe("u1");
    ticks.changed();
    expect(published).toEqual([{ stream: "overview", key: "u1", event: { kind: "changed" } }]);
  });

  it("sends a storm of 100 changes in 900 ms as one tick at once and one trailing tick, per user", async () => {
    const { clock, ticks, published, subscribe } = bed();
    subscribe("u1");
    subscribe("u2");
    for (let i = 0; i < 100; i += 1) {
      ticks.changed();
      await clock.advance(9);
    }
    expect(clock.now()).toBe(10_900);
    expect(countOf(published, "u1")).toBe(1);
    expect(countOf(published, "u2")).toBe(1);
    await clock.advance(TICK_EVERY_MS);
    expect(countOf(published, "u1")).toBe(2);
    expect(countOf(published, "u2")).toBe(2);
    await clock.advance(10 * TICK_EVERY_MS);
    expect(published).toHaveLength(4);
    expect(clock.pending()).toBe(0);
  });

  it("ticks again at once once a quiet second has passed", async () => {
    const { clock, ticks, published, subscribe } = bed();
    subscribe("u1");
    ticks.changed();
    await clock.advance(TICK_EVERY_MS);
    ticks.changed();
    expect(countOf(published, "u1")).toBe(2);
  });

  it("sends nothing after the last subscriber left, and drops its trailing tick", async () => {
    const { clock, ticks, published, subscribe, leave } = bed();
    subscribe("u1");
    ticks.changed();
    ticks.changed();
    expect(published).toHaveLength(1);
    leave("u1");
    expect(clock.pending()).toBe(0);
    await clock.advance(5 * TICK_EVERY_MS);
    ticks.changed();
    expect(published).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("drops a trailing tick for a viewer the hub lost without telling", async () => {
    const { clock, ticks, published, subscribe, subscribed } = bed();
    subscribe("u1");
    ticks.changed();
    ticks.changed();
    subscribed.delete("u1");
    await clock.advance(2 * TICK_EVERY_MS);
    expect(published).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it("drops a user the hub no longer holds, even when no leave was told", async () => {
    const { clock, ticks, published, subscribe } = bed();
    subscribe("u1");
    ticks.changed();
    ticks.close("u1");
    ticks.changed();
    await clock.advance(2 * TICK_EVERY_MS);
    expect(published).toHaveLength(1);
  });

  it("forgets a user whose subscription never came", async () => {
    const { ticks, published } = bed();
    ticks.open("ghost");
    ticks.changed();
    ticks.changed();
    expect(published).toHaveLength(0);
  });

  it("stops: no timer is left and nothing is sent", async () => {
    const { clock, ticks, published, subscribe } = bed();
    subscribe("u1");
    ticks.changed();
    ticks.changed();
    ticks.stop();
    expect(clock.pending()).toBe(0);
    ticks.changed();
    await clock.advance(3 * TICK_EVERY_MS);
    expect(published).toHaveLength(1);
  });

  it("logs a publish that throws and still ticks the other users", async () => {
    const clock = createFakeClock(10_000);
    const lines: Array<Record<string, unknown>> = [];
    const logger = createLogger({
      level: "debug",
      clock,
      write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    const published: string[] = [];
    const publish = vi.fn((_stream: string, key: string) => {
      if (key === "bad") throw new TypeError("not serialisable");
      published.push(key);
    });
    const ticks = createOverviewTicks({
      clock,
      logger,
      hub: {
        registerSnapshot: () => {},
        publish,
        hasSubscribers: () => true,
        onLastSubscriberLeft: () => {},
      },
    });
    ticks.open("bad");
    ticks.open("good");
    ticks.changed();
    expect(published).toEqual(["good"]);
    expect(lines.some((line) => line.msg === "overview_tick_failed")).toBe(true);
  });
});
