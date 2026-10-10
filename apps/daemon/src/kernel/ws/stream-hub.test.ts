import type { EventFrame } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createStreamHub, MAX_REPLAY_EVENTS } from "./stream-hub.ts";

function setup() {
  const hub = createStreamHub("epoch-1");
  hub.registerSnapshot("session", (key) => ({ kind: "snapshot", key }));
  const frames: EventFrame[] = [];
  const open = (after?: { epoch: string; seq: number }, sub = "s1", key = "k", connectionId = "c1") =>
    hub.open({ connectionId, sub, stream: "session", key, after, send: (frame) => frames.push(frame) });
  return { hub, frames, open };
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
