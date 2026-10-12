import type { WorkerRecord } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRogueBed, rejection, type RogueBed, waitForReady } from "../testing/rogue-bed.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_WORKER_STRING, OUTPUT_TAIL_BYTES } from "./worker.ts";

let bed: RogueBed;
beforeEach(() => {
  bed = createRogueBed();
});
afterEach(() => bed.dispose());

describe("a worker that sends garbage", () => {
  it("has every invalid record dropped and counted, and the valid ones delivered", async () => {
    const handle = bed.rogue("garbage");
    const records = bed.collect(handle);
    await waitForReady(records);
    // An audit record with a junk entry is a valid record: its entry travels as unknown and the audit module turns it
    // into an `invalid` row (M5R113, M5R46), so it is delivered and not counted among the dropped.
    expect(records.map((record) => record.type)).toEqual(["audit", "ready"]);
    expect(handle.stats().droppedRecords).toBe(10);
    expect(bed.logged.filter((entry) => entry.msg === "worker_record_dropped").length).toBeLessThan(10);
  });

  it("has a response nobody asked for dropped and counted", async () => {
    const handle = bed.rogue("unknown-response");
    await waitForReady(bed.collect(handle));
    expect(handle.stats().unknownResponses).toBe(1);
  });

  it("clips the strings of extension errors and of failed responses", async () => {
    const handle = bed.rogue("long-strings");
    const records = bed.collect(handle);
    await vi.waitFor(() => expect(records.some((record) => record.type === "extension_error")).toBe(true));
    const failure = records.find((record) => record.type === "extension_error");
    expect(failure).toMatchObject({ type: "extension_error" });
    for (const field of ["extensionPath", "event", "error"] as const) {
      expect((failure as unknown as Record<string, string>)[field]?.length).toBeLessThanOrEqual(
        MAX_WORKER_STRING + 1,
      );
    }
    const response = await handle.request({ type: "get_state" }, 5000);
    expect(response.success).toBe(false);
    expect(response.error?.length).toBeLessThanOrEqual(MAX_WORKER_STRING + 1);
  });

  it("does not let a throwing listener hurt the daemon, the other listeners or the worker", async () => {
    const handle = bed.rogue("flood");
    handle.onRecord(() => {
      throw new Error("listener bug");
    });
    const records = bed.collect(handle);
    await waitForReady(records);
    expect(records).toHaveLength(20_001);
    expect(handle.stats().listenerErrors).toBe(20_001);
    expect(bed.logged.filter((entry) => entry.msg === "worker_listener_failed").length).toBeLessThan(20);
    expect(handle.stats().droppedRecords).toBe(0);
  });

  it("delivers a record to the listeners that were there when it arrived", async () => {
    const handle = bed.rogue("flood");
    const seen: string[] = [];
    const lateComers: WorkerRecord[] = [];
    const second = (record: WorkerRecord) => seen.push(`second:${record.type}`);
    let offSecond = () => {};
    handle.onRecord((record) => {
      if (record.type !== "ready") return;
      seen.push("first:ready");
      offSecond();
      handle.onRecord((late) => lateComers.push(late));
    });
    offSecond = handle.onRecord(second);
    await vi.waitFor(() => expect(seen).toContain("first:ready"));
    expect(seen).toContain("second:ready");
    expect(lateComers.some((record) => record.type === "ready")).toBe(false);
  });
});

describe("a worker that floods", () => {
  it("keeps only the last 8 KiB of its output, and the exit is reported after the last of it", async () => {
    expect(OUTPUT_TAIL_BYTES).toBe(8 * 1024);
    const handle = bed.rogue("loud");
    await waitForReady(bed.collect(handle));
    const tail = handle.outputTail();
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
    expect(tail.endsWith("TAIL-MARKER\n")).toBe(true);
    const stopping = handle.stop();
    await bed.clock.advance(2000);
    await bed.clock.advance(3000);
    await stopping;
    expect(Buffer.byteLength(handle.outputTail())).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
  });
});

describe("request timeouts", () => {
  it("reject a slow answer with timeout, not worker_failed, and forget the request", async () => {
    const handle = bed.rogue("late");
    await waitForReady(bed.collect(handle));
    const first = rejection(handle.request({ type: "get_state" }, 1000));
    expect(handle.stats().pendingRequests).toBe(1);
    await bed.clock.advance(1000);
    expect(await first).toBe("timeout");
    expect(handle.stats().pendingRequests).toBe(0);
    expect(bed.clock.pending()).toBe(0);
  });

  it("give every command but prompt 30 s by default", async () => {
    const handle = bed.rogue("silent");
    await waitForReady(bed.collect(handle));
    const state = rejection(handle.request({ type: "get_state" }));
    const abort = rejection(handle.request({ type: "abort" }));
    void handle.request({ type: "prompt", message: "go" }).catch(() => undefined);
    await bed.clock.advance(DEFAULT_REQUEST_TIMEOUT_MS - 1);
    expect(handle.stats().pendingRequests).toBe(3);
    await bed.clock.advance(1);
    expect([await state, await abort]).toEqual(["timeout", "timeout"]);
    expect(handle.stats().pendingRequests).toBe(1);
  });

  it("leave a prompt waiting as long as the worker lives: an extension command answers when it ends", async () => {
    const handle = bed.rogue("late");
    await waitForReady(bed.collect(handle));
    const answer = handle.request({ type: "prompt", message: "/long-dialog" });
    await bed.clock.advance(60 * 60 * 1000);
    expect(handle.stats().pendingRequests).toBe(1);
    expect(bed.clock.pending()).toBe(0);
    void rejection(handle.request({ type: "abort" }, 60_000));
    expect(await answer).toMatchObject({ command: "prompt", success: true });
    expect(handle.stats().unknownResponses).toBe(0);
  });

  it("apply to a prompt that names its own", async () => {
    const handle = bed.rogue("late");
    await waitForReady(bed.collect(handle));
    const answer = rejection(handle.request({ type: "prompt", message: "go" }, 5000));
    await bed.clock.advance(5000);
    expect(await answer).toBe("timeout");
  });

  it("leave the worker alone: a request that timed out does not stop the next one", async () => {
    const handle = bed.rogue("late");
    await waitForReady(bed.collect(handle));
    const slow = rejection(handle.request({ type: "get_state" }, 1000));
    await bed.clock.advance(1000);
    expect(await slow).toBe("timeout");
    const next = handle.request({ type: "prompt", message: "go" });
    void rejection(handle.request({ type: "abort" }, 5000));
    expect(await next).toMatchObject({ success: true });
    expect(handle.stats().pendingRequests).toBe(1);
  });

  it("count the answer that comes after the timeout, and fail what waits when the worker dies", async () => {
    const handle = bed.rogue("late");
    await waitForReady(bed.collect(handle));
    const late = rejection(handle.request({ type: "get_state" }, 1000));
    await bed.clock.advance(1000);
    expect(await late).toBe("timeout");
    const poke = rejection(handle.request({ type: "abort" }, 60_000));
    await vi.waitFor(() => expect(handle.stats().unknownResponses).toBe(1));
    expect(handle.stats().pendingRequests).toBe(1);
    void handle.stop();
    await bed.clock.advance(5000);
    expect(await poke).toBe("worker_failed");
    expect(handle.stats().pendingRequests).toBe(0);
  });
});
