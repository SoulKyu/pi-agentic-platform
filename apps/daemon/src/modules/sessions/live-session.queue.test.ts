import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { startLiveSession } from "./live-session.ts";
import { PAGE_BYTES, sizeOf } from "./snapshot.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS } from "../../kernel/supervisor/worker.ts";
import { captureLogger } from "./testing/helpers.ts";
import { createLiveBed, piEvent } from "./testing/live-bed.ts";

const setup = createLiveBed(startLiveSession);
const idOf = (worker: { requests: Array<{ type: string; id: string }> }, type: string, nth = 0) =>
  worker.requests.filter((request) => request.type === type)[nth]?.id ?? "";

describe("the steering queue", () => {
  it("publishes the queue and refuses a prompt over the cap without sending it", async () => {
    const { live, worker, published, clock } = setup();
    worker.emit(piEvent({ type: "queue_update", steering: ["left"], followUp: [], count: 128, bytes: 4 }));
    await clock.advance(0);
    expect(published.at(-1)).toEqual({
      kind: "queue",
      queue: { steering: ["left"], followUp: [], count: 128, bytes: 4 },
    });
    expect(published.some((event) => event.kind === "pi" && event.event.type === "queue_update")).toBe(false);
    await expect(live.prompt("one more", "steer")).rejects.toThrow(new PapError("queue_full"));
    expect(worker.requests.filter((request) => request.type === "prompt")).toEqual([]);
  });

  it("counts a prompt in flight until Pi answers it, then Pi's own count takes over", async () => {
    const { live, worker, clock } = setup({ holdPrompt: true });
    worker.emit(piEvent({ type: "queue_update", steering: [], followUp: [], count: 127, bytes: 4 }));
    await clock.advance(0);
    const first = live.prompt("one", "steer");
    await expect(live.prompt("two", "steer")).rejects.toThrow(new PapError("queue_full"));
    worker.respond(idOf(worker, "prompt"), { data: { disposition: "queued" } });
    await first;
    const third = live.prompt("three", "steer");
    await expect(live.prompt("four", "steer")).rejects.toThrow(new PapError("queue_full"));
    worker.respond(idOf(worker, "prompt", 1), { data: { disposition: "queued" } });
    await third;
    expect(worker.requests.filter((request) => request.type === "prompt")).toHaveLength(2);
  });

  it("uncounts a prompt Pi rejected", async () => {
    const { live, worker, clock } = setup({ promptFails: true });
    worker.emit(piEvent({ type: "queue_update", steering: [], followUp: [], count: 127, bytes: 4 }));
    await clock.advance(0);
    await expect(live.prompt("one", "steer")).rejects.toThrow(new PapError("prompt_rejected"));
    await expect(live.prompt("two", "steer")).rejects.toThrow(new PapError("prompt_rejected"));
  });

  it("forgets the queue when the worker is gone", async () => {
    const { live, worker, clock } = setup();
    worker.emit(piEvent({ type: "queue_update", steering: ["a"], followUp: [], count: 1, bytes: 1 }));
    await clock.advance(0);
    expect(live.queue().count).toBe(1);
    await live.stop();
    await clock.advance(0);
    expect(live.queue()).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
  });

  it("clears the queue and returns what was waiting", async () => {
    const { live, worker } = setup({
      clearQueue: { data: { steering: ["a"], followUp: ["b"], truncated: false } },
    });
    expect(await live.clearQueue()).toEqual({ steering: ["a"], followUp: ["b"], truncated: false });
    expect(worker.requests.filter((request) => request.type === "clear_queue")).toHaveLength(1);
  });

  it("answers worker_failed when Pi refuses to clear", async () => {
    const { live } = setup({ clearQueue: { success: false, error: "no" } });
    await expect(live.clearQueue()).rejects.toThrow(new PapError("worker_failed"));
  });

  it("fits whatever the worker sent in the frame, and says when it left something out", async () => {
    const nasty = '"\\\u0000\u001f'.repeat(2000);
    const texts = Array.from({ length: 128 }, () => nasty);
    const { live } = setup({
      clearQueue: {
        data: { steering: texts, followUp: [...texts, 7, "x".repeat(200_001)], truncated: false },
      },
    });
    const cleared = await live.clearQueue();
    expect(cleared.truncated).toBe(true);
    expect(sizeOf(cleared)).toBeLessThanOrEqual(PAGE_BYTES);
    const room = PAGE_BYTES - sizeOf({ steering: [], followUp: [], truncated: true });
    const kept = Math.floor(room / (Buffer.byteLength(JSON.stringify(nasty)) + 1));
    expect(cleared.steering).toEqual(Array.from({ length: kept }, () => nasty));
    expect(cleared.followUp).toEqual([]);
  });

  it("keeps the worker's own truncated flag, and reads an unexpected answer as empty and truncated", async () => {
    const said = setup({ clearQueue: { data: { steering: ["a"], followUp: [], truncated: true } } });
    expect(await said.live.clearQueue()).toEqual({ steering: ["a"], followUp: [], truncated: true });
    const odd = setup({ clearQueue: { data: "garbage" } });
    expect(await odd.live.clearQueue()).toEqual({ steering: [], followUp: [], truncated: true });
  });

  it("passes a timeout on unchanged and asks the worker once: the outcome is unknown, not a failure (R105)", async () => {
    const { live, worker, clock } = setup({ clearQueue: { hold: true } });
    const cleared = live.clearQueue();
    const outcome = expect(cleared).rejects.toThrow(new PapError("timeout"));
    await clock.advance(DEFAULT_REQUEST_TIMEOUT_MS);
    await outcome;
    await clock.advance(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(worker.requests.filter((request) => request.type === "clear_queue")).toHaveLength(1);
  });

  it("logs a reply it cannot read, once, and still answers empty and truncated", async () => {
    const { logger, lines } = captureLogger();
    const { live } = setup({ logger, clearQueue: { data: { steering: "no" } } });
    expect(await live.clearQueue()).toEqual({ steering: [], followUp: [], truncated: true });
    expect(lines.filter((line) => line.msg === "clear_queue_unreadable")).toHaveLength(1);
  });

  it("does not bring a queue back from an update that comes after the worker is gone", async () => {
    const { live, worker, clock, published } = setup();
    await live.stop();
    await clock.advance(0);
    const before = published.length;
    worker.emit(piEvent({ type: "queue_update", steering: ["late"], followUp: [], count: 1, bytes: 4 }));
    await clock.advance(0);
    expect(live.queue()).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
    expect(published.slice(before)).toEqual([]);
  });
});
