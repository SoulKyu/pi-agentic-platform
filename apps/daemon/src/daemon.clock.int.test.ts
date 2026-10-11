import type { EventFrame } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { IDLE_RING_MS } from "./kernel/ws/stream-hub.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

const SCRIPT = { steps: [{ text: "hello" }] };
const kind = (frame: EventFrame) => (frame.event as { kind?: string }).kind;

let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

describe("the daemon's injected clock", () => {
  it("also times the stream hub: an unwatched session's replay ring is dropped after IDLE_RING_MS", async () => {
    const clock = createFakeClock();
    t = await startTestDaemon(SCRIPT, { deps: { clock } });
    const cookie = await t.login();
    const first = await t.connect(cookie);
    const created = await first.call("sessions.create", { cwd: t.cwd });
    const sessionId = (created.ok ? (created.result as { sessionId: string }).sessionId : "") || "none";
    await first.call("subscribe.session", { sessionId });
    await first.call("sessions.prompt", { sessionId, text: "hi" });
    await first.waitForEvent(
      (frame) => kind(frame) === "pi" && JSON.stringify(frame.event).includes("hello"),
    );
    const earlier = first.events.at(1);
    if (!earlier) throw new Error("the run produced no events");
    first.close();
    await first.closed;

    // Within the window a cursor still replays; after it the ring is gone and the client gets a snapshot.
    const soon = await t.connect(cookie);
    await soon.call("subscribe.session", { sessionId, after: { epoch: earlier.epoch, seq: earlier.seq } });
    expect(kind(await soon.waitForEvent(() => true))).not.toBe("snapshot");
    soon.close();
    await soon.closed;

    await clock.advance(IDLE_RING_MS);
    const late = await t.connect(cookie);
    await late.call("subscribe.session", { sessionId, after: { epoch: earlier.epoch, seq: earlier.seq } });
    expect(kind(await late.waitForEvent(() => true))).toBe("snapshot");
    late.close();
  });
});
