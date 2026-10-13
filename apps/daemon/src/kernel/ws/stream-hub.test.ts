import type { EventFrame } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { PapError } from "@pap/contracts";
import { createFakeClock } from "../clock.ts";
import { createStreamHub, IDLE_RING_MS, MAX_REPLAY_EVENTS } from "./stream-hub.ts";

function setup() {
  const clock = createFakeClock();
  const hub = createStreamHub("epoch-1", clock);
  hub.registerSnapshot("session", (key) => ({ kind: "snapshot", key }));
  const frames: EventFrame[] = [];
  const open = (after?: { epoch: string; seq: number }, sub = "s1", key = "k", connectionId = "c1") =>
    hub.open({ connectionId, sub, stream: "session", key, after, send: (frame) => frames.push(frame) });
  return { hub, clock, frames, open };
}

describe("stream hub", () => {
  it("sends a snapshot first, then live events with increasing seq", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    open();
    hub.publish("session", "k", { n: 2 });
    expect(frames).toEqual([
      { sub: "s1", epoch: "epoch-1", seq: 1, event: { kind: "snapshot", key: "k" } },
      { sub: "s1", epoch: "epoch-1", seq: 2, event: { n: 2 } },
    ]);
  });

  it("replays only the gap for a cursor of the same epoch", () => {
    const { hub, frames, open } = setup();
    for (const n of [1, 2, 3]) hub.publish("session", "k", { n });
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames.map((f) => f.seq)).toEqual([2, 3]);
  });

  it("sends nothing when the cursor is current", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames).toEqual([]);
  });

  it("a cursor from another epoch gets a snapshot", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    open({ epoch: "epoch-0", seq: 1 });
    expect(frames[0]?.event).toEqual({ kind: "snapshot", key: "k" });
  });

  it("a cursor older than the ring, or ahead of the server, gets a snapshot", () => {
    const { hub, frames, open } = setup();
    for (let n = 0; n < MAX_REPLAY_EVENTS + 5; n++) hub.publish("session", "k", { n });
    open({ epoch: "epoch-1", seq: 1 }, "old");
    open({ epoch: "epoch-1", seq: 10_000 }, "ahead");
    expect(
      frames.filter((f) => (f.event as { kind?: string }).kind === "snapshot").map((f) => f.sub),
    ).toEqual(["old", "ahead"]);
  });

  it("replays a gap that starts exactly at the oldest kept event", () => {
    const { hub, frames, open } = setup();
    const total = MAX_REPLAY_EVENTS + 5;
    for (let n = 0; n < total; n++) hub.publish("session", "k", { n });
    open({ epoch: "epoch-1", seq: total - MAX_REPLAY_EVENTS });
    expect(frames).toHaveLength(MAX_REPLAY_EVENTS);
    expect(frames[0]?.seq).toBe(total - MAX_REPLAY_EVENTS + 1);
  });

  it("trims the ring by bytes", () => {
    const { hub, frames, open } = setup();
    for (let n = 0; n < 3; n++) hub.publish("session", "k", { blob: "x".repeat(600_000) });
    open({ epoch: "epoch-1", seq: 0 });
    expect((frames[0]?.event as { kind?: string }).kind).toBe("snapshot");
  });

  it("falls back to a snapshot when one event alone exceeds the byte cap", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "k", { blob: "x".repeat(2 * 1024 * 1024) });
    open({ epoch: "epoch-1", seq: 0 });
    expect(frames).toEqual([{ sub: "s1", epoch: "epoch-1", seq: 1, event: { kind: "snapshot", key: "k" } }]);
  });

  it("stops delivery after close", () => {
    const { hub, frames, open } = setup();
    open();
    hub.close("c1", "s1");
    hub.publish("session", "k", { n: 1 });
    expect(frames).toHaveLength(1);
  });

  it("closes every subscription of a connection, and only that connection", () => {
    const { hub, frames, open } = setup();
    open(undefined, "s1", "a", "c1");
    open(undefined, "s2", "b", "c1");
    open(undefined, "s1", "a", "c2");
    frames.length = 0;
    hub.close("c1");
    hub.publish("session", "a", { n: 1 });
    hub.publish("session", "b", { n: 1 });
    expect(frames.map((f) => f.sub)).toEqual(["s1"]);
  });

  it("keeps a separate sequence per key", () => {
    const { hub, frames, open } = setup();
    hub.publish("session", "a", { n: 1 });
    hub.publish("session", "a", { n: 2 });
    open(undefined, "s1", "b");
    hub.publish("session", "b", { n: 1 });
    expect(frames.map((f) => f.seq)).toEqual([0, 1]);
  });

  it("refuses to open a stream without a snapshot provider", () => {
    const hub = createStreamHub("epoch-1");
    expect(() =>
      hub.open({
        connectionId: "c1",
        sub: "s1",
        stream: "session",
        key: "k",
        after: undefined,
        send: () => {},
      }),
    ).toThrow("no snapshot provider");
  });

  it("starts every hub on its own random epoch", () => {
    expect(createStreamHub().epoch).not.toBe(createStreamHub().epoch);
  });
});

describe("stream hub prepare and commit", () => {
  const input = (frames: EventFrame[], after?: { epoch: string; seq: number }) => ({
    connectionId: "c1",
    sub: "s1",
    stream: "session" as const,
    key: "k",
    after,
    send: (frame: EventFrame) => frames.push(frame),
  });

  it("sends nothing before commit, then the prepared frames, then what was published meanwhile, in order", () => {
    const { hub, frames } = setup();
    hub.publish("session", "k", { n: 1 });
    const prepared = hub.prepare(input(frames));
    hub.publish("session", "k", { n: 2 });
    hub.publish("session", "k", { n: 3 });
    expect(frames).toEqual([]);
    prepared.commit();
    hub.publish("session", "k", { n: 4 });
    expect(frames.map((f) => [f.seq, (f.event as { n?: number }).n ?? "snapshot"])).toEqual([
      [1, "snapshot"],
      [2, 2],
      [3, 3],
      [4, 4],
    ]);
  });

  it("replays the gap at commit and keeps events published between prepare and commit", () => {
    const { hub, frames } = setup();
    for (const n of [1, 2, 3]) hub.publish("session", "k", { n });
    const prepared = hub.prepare(input(frames, { epoch: "epoch-1", seq: 1 }));
    hub.publish("session", "k", { n: 4 });
    prepared.commit();
    expect(frames.map((f) => f.seq)).toEqual([2, 3, 4]);
  });

  it("registers nothing when the snapshot provider throws, and leaves no channel behind", () => {
    const { hub, frames } = setup();
    hub.registerSnapshot("session", () => {
      throw new PapError("not_found");
    });
    expect(() => hub.prepare(input(frames))).toThrow(PapError);
    hub.publish("session", "other", { n: 1 });
    expect(hub.stats()).toEqual({ channels: 1, subscriptions: 0 });
    expect(frames).toEqual([]);
  });

  it("registers nothing when the stream has no snapshot provider", () => {
    const hub = createStreamHub("epoch-1", createFakeClock());
    expect(() => hub.prepare(input([]))).toThrow("no snapshot provider");
    expect(hub.stats()).toEqual({ channels: 0, subscriptions: 0 });
  });

  it("settles a shell subscription made before its provider exists: it throws, leaves nothing, and works once registered", () => {
    const hub = createStreamHub("epoch-1", createFakeClock());
    const frames: EventFrame[] = [];
    const open = () =>
      hub.open({
        connectionId: "c1",
        sub: "s1",
        stream: "shell",
        key: "u1",
        after: undefined,
        send: (f) => frames.push(f),
      });
    expect(open).toThrow("no snapshot provider for stream shell");
    hub.publish("shell", "u1", { kind: "counts", archived: 1 });
    expect(hub.stats()).toEqual({ channels: 1, subscriptions: 0 });
    hub.registerSnapshot("shell", () => ({ kind: "snapshot" }));
    open();
    expect(frames).toEqual([{ sub: "s1", epoch: "epoch-1", seq: 1, event: { kind: "snapshot" } }]);
  });

  it("a subscription closed before commit receives nothing", () => {
    const { hub, frames } = setup();
    const prepared = hub.prepare(input(frames));
    hub.publish("session", "k", { n: 1 });
    hub.close("c1", "s1");
    prepared.commit();
    hub.publish("session", "k", { n: 2 });
    expect(frames).toEqual([]);
    expect(hub.stats().subscriptions).toBe(0);
  });
});

describe("stream hub memory", () => {
  it("keeps the ring while a channel has been without subscribers for under 5 minutes", async () => {
    const { hub, clock, frames, open } = setup();
    for (const n of [1, 2, 3]) hub.publish("session", "k", { n });
    await clock.advance(IDLE_RING_MS - 1000);
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames.map((f) => f.seq)).toEqual([2, 3]);
  });

  it("drops the ring after 5 minutes without subscribers but keeps counting, so stale cursors get a snapshot", async () => {
    const { hub, clock, frames, open } = setup();
    for (const n of [1, 2, 3]) hub.publish("session", "k", { n });
    await clock.advance(IDLE_RING_MS);
    hub.publish("session", "k", { n: 4 });
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames).toEqual([{ sub: "s1", epoch: "epoch-1", seq: 4, event: { kind: "snapshot", key: "k" } }]);
  });

  it("measures the 5 minutes from the moment the last subscriber left", async () => {
    const { hub, clock, frames, open } = setup();
    open(undefined, "s1");
    hub.publish("session", "k", { n: 1 });
    await clock.advance(10 * IDLE_RING_MS);
    hub.publish("session", "k", { n: 2 });
    hub.close("c1");
    await clock.advance(IDLE_RING_MS - 1);
    frames.length = 0;
    open({ epoch: "epoch-1", seq: 0 }, "again");
    expect(frames.map((f) => f.seq)).toEqual([1, 2]);
  });

  it("a cursor equal to the kept counter still resumes after the ring was dropped", async () => {
    const { hub, clock, frames, open } = setup();
    hub.publish("session", "k", { n: 1 });
    await clock.advance(IDLE_RING_MS);
    open({ epoch: "epoch-1", seq: 1 });
    expect(frames).toEqual([]);
  });

  it("arms no timer for a channel that is watched or empty", async () => {
    const { hub, clock, open } = setup();
    open();
    hub.publish("session", "k", { n: 1 });
    expect(clock.pending()).toBe(0);
    hub.close("c1");
    expect(clock.pending()).toBe(1);
    open();
    expect(clock.pending()).toBe(0);
  });
});

describe("stream hub publish failures", () => {
  it("leaves no sequence hole and no channel when the event cannot be serialised", () => {
    const { hub, frames, open } = setup();
    expect(() => hub.publish("session", "fresh", { big: 1n })).toThrow(TypeError);
    expect(hub.stats().channels).toBe(0);
    open();
    hub.publish("session", "k", { n: 1 });
    expect(() => hub.publish("session", "k", { big: 1n })).toThrow(TypeError);
    expect(() => hub.publish("session", "k", undefined)).toThrow(TypeError);
    hub.publish("session", "k", { n: 2 });
    expect(frames.map((f) => f.seq)).toEqual([0, 1, 2]);
  });
});
