import type { PiEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createFakeWorker } from "../../kernel/testing/fake-worker.ts";
import { startLiveSession } from "./live-session.ts";
import { INIT, piEvent, READY } from "./testing/live-bed.ts";

function setup(observe?: (event: PiEvent) => void) {
  const clock = createFakeClock();
  const worker = createFakeWorker({ clock, reply: () => ({}) });
  const published: Array<{ kind: string; event?: PiEvent }> = [];
  const live = startLiveSession(
    {
      handle: worker,
      clock,
      logger: silentLogger,
      publish: (event) => published.push(event as { kind: string; event?: PiEvent }),
      record: () => {},
      onActivity: () => {},
      onExit: () => {},
      onName: () => {},
      idleMs: 0,
      ...(observe ? { observe } : {}),
    },
    INIT,
  );
  worker.emit(READY);
  return { clock, worker, published, live };
}

const longError = "provider said: " + "x".repeat(9000);
const compaction = (errorMessage: string): PiEvent => ({
  type: "compaction_end",
  reason: "threshold",
  aborted: true,
  willRetry: false,
  result: undefined,
  errorMessage,
});

describe("the observe hook (M10R84)", () => {
  it("sees the raw event, before the wire's clipping takes the error text out", async () => {
    const seen: PiEvent[] = [];
    const { worker, clock, published } = setup((event) => void seen.push(event));
    const raw = compaction(longError);
    worker.emit(piEvent(raw));
    await clock.advance(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(raw);
    expect(seen[0]?.errorMessage).toBe(longError);
    const onWire = published.map((item) => item.event).find((event) => event?.type === "compaction_end");
    expect(onWire).toBeDefined();
    expect(onWire).not.toHaveProperty("errorMessage");
    expect(onWire).toHaveProperty("failed", true);
  });

  it("sees a tool call's arguments uncut", async () => {
    const seen: PiEvent[] = [];
    const { worker, clock } = setup((event) => void seen.push(event));
    const args = { text: "a".repeat(20_000) };
    const raw: PiEvent = { type: "tool_execution_start", toolCallId: "c", toolName: "write", args };
    worker.emit(piEvent(raw));
    await clock.advance(0);
    expect(seen[0]).toBe(raw);
    expect((seen[0]?.args as { text: string }).text).toHaveLength(20_000);
  });

  it("is called once per event, system messages included", async () => {
    const seen: PiEvent[] = [];
    const { worker, clock } = setup((event) => void seen.push(event));
    worker.emit(piEvent({ type: "agent_start" }));
    worker.emit(piEvent({ type: "message_end", message: { role: "system", content: "prompt" } }));
    worker.emit(piEvent({ type: "message_end", message: { role: "assistant", content: [] } }));
    await clock.advance(0);
    expect(seen.map((event) => event.type)).toEqual(["agent_start", "message_end", "message_end"]);
  });

  it("works without an observer", async () => {
    const { worker, clock, live } = setup();
    worker.emit(piEvent({ type: "agent_start" }));
    await clock.advance(0);
    expect(live.status()).toBe("running");
  });
});
