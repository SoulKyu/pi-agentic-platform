import type { PapError, WorkerRecord } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { DEFAULT_REQUEST_TIMEOUT_MS, MAX_SHUTDOWN_GRACE_MS } from "../supervisor/worker.ts";
import { createFakeWorker } from "./fake-worker.ts";

const READY: WorkerRecord = { type: "ready", sessionFile: "/s.jsonl", sessionId: "s", piVersion: "1" };

describe("fake worker", () => {
  it("answers scripted requests, holds others, and rejects them on a crash", async () => {
    const worker = createFakeWorker({
      reply: (command) => (command.type === "get_state" ? { data: { ok: 1 } } : undefined),
    });
    expect(await worker.request({ type: "get_state" })).toMatchObject({ success: true, data: { ok: 1 } });
    const held = worker.request({ type: "abort" });
    worker.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await expect(held).rejects.toThrow();
    expect((await worker.exited).cause).toBe("killed");
    expect(worker.send({ type: "get_state", id: "x" })).toBe(false);
  });

  it("answers a held request by id, with the command that was asked", async () => {
    const worker = createFakeWorker();
    const held = worker.request({ type: "abort" });
    const id = worker.requests[0]?.id ?? "";
    worker.respond(id, { data: { aborted: true } });
    expect(await held).toEqual({
      type: "response",
      id,
      command: "abort",
      success: true,
      data: { aborted: true },
    });
    expect(() => worker.respond(id, {})).toThrow("no pending request");
  });

  it("times a held request out with the clock it was given, with timeout, and forgets it", async () => {
    const clock = createFakeClock();
    const worker = createFakeWorker({ clock });
    const outcome = worker.request({ type: "get_state" }, 1000).then(
      () => "answered",
      (error: PapError) => error.code,
    );
    expect(worker.stats().pendingRequests).toBe(1);
    await clock.advance(1000);
    expect(await outcome).toBe("timeout");
    expect(worker.stats().pendingRequests).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("gives every command but prompt the real handle's default timeout", async () => {
    const clock = createFakeClock();
    const worker = createFakeWorker({ clock });
    const state = worker.request({ type: "abort" }).then(
      () => "answered",
      (error: PapError) => error.code,
    );
    const prompt = worker.request({ type: "prompt", message: "/long-dialog" });
    await clock.advance(DEFAULT_REQUEST_TIMEOUT_MS);
    expect(await state).toBe("timeout");
    expect(worker.stats().pendingRequests).toBe(1);
    expect(clock.pending()).toBe(0);
    worker.respond(worker.requests[1]?.id ?? "", { data: { disposition: "handled" } });
    expect(await prompt).toMatchObject({ command: "prompt", success: true });
  });

  it("counts a response nobody waits for, like the real handle", () => {
    const worker = createFakeWorker();
    worker.emit({ type: "response", id: "r9", command: "get_state", success: true });
    expect(worker.stats().unknownResponses).toBe(1);
  });

  it("delivers worker records to listeners, isolates one that throws, and goes quiet once the worker is gone", async () => {
    const worker = createFakeWorker();
    const seen: string[] = [];
    worker.onRecord(() => {
      throw new Error("listener bug");
    });
    const off = worker.onRecord((record) => seen.push(record.type));
    worker.emit(READY);
    expect(seen).toEqual(["ready"]);
    expect(worker.stats().listenerErrors).toBe(1);
    off();
    worker.emit(READY);
    expect(seen).toEqual(["ready"]);
    const again = createFakeWorker();
    again.onRecord((record) => seen.push(`again:${record.type}`));
    await again.stop();
    again.emit(READY);
    expect(seen).toEqual(["ready"]);
  });

  it("caps shutdown.graceMs like the real handle, and records what it was sent", () => {
    const worker = createFakeWorker();
    worker.send({ type: "shutdown", graceMs: 10 ** 9 });
    worker.send({ type: "shutdown", graceMs: 100 });
    expect(worker.sent).toEqual([
      { type: "shutdown", graceMs: MAX_SHUTDOWN_GRACE_MS },
      { type: "shutdown", graceMs: 100 },
    ]);
  });

  it("delivers a record to the listeners that were there when it arrived", () => {
    const worker = createFakeWorker();
    const seen: string[] = [];
    let offSecond = () => {};
    worker.onRecord(() => {
      seen.push("first");
      offSecond();
      worker.onRecord(() => seen.push("late"));
    });
    offSecond = worker.onRecord(() => seen.push("second"));
    worker.emit(READY);
    expect(seen).toEqual(["first", "second"]);
  });

  it("is told to shut down when it is stopped, like the real handle, and not when it is already gone", async () => {
    const worker = createFakeWorker();
    await worker.stop();
    await worker.stop();
    expect(worker.sent).toEqual([{ type: "shutdown", graceMs: 1500 }]);
    const crashed = createFakeWorker();
    crashed.crash({ code: 1, signal: null, cause: "exit_code" });
    await crashed.stop();
    expect(crashed.sent).toEqual([]);
  });

  it("stops once, whoever asks and whenever", async () => {
    const worker = createFakeWorker();
    expect(worker.stopped()).toBe(false);
    const first = await worker.stop();
    expect(await worker.stop()).toBe(first);
    expect(first.cause).toBe("clean");
    expect(worker.stopped()).toBe(true);
    const crashed = createFakeWorker();
    crashed.crash({ code: 70, signal: null, cause: "exit_code" });
    expect((await crashed.stop()).cause).toBe("exit_code");
  });
});
