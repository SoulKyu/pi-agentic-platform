import { PapError } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../clock.ts";
import { type LogFields, type Logger, silentLogger } from "../logger.ts";
import { createWorkerCore, type WorkerCore } from "./worker-core.ts";

let clock: FakeClock;
let logs: Array<{ level: string; msg: string; fields: LogFields | undefined }>;
let core: WorkerCore;
let sent: unknown[];

const logger: Logger = {
  ...silentLogger,
  warn: (msg, fields) => void logs.push({ level: "warn", msg, fields }),
  error: (msg, fields) => void logs.push({ level: "error", msg, fields }),
};
const ready = { type: "ready", sessionFile: "/s.jsonl", sessionId: "s1", piVersion: "1.1.0" };
const send = (record: unknown): boolean => {
  sent.push(record);
  return true;
};

beforeEach(() => {
  clock = createFakeClock();
  logs = [];
  sent = [];
  core = createWorkerCore({ clock, logger, label: { pid: 7 } });
});

describe("the worker record core", () => {
  it("resolves a request with the response that carries its id", async () => {
    const answer = core.request({ type: "get_state" }, 5000, send);
    expect(sent).toEqual([{ type: "get_state", id: "r1" }]);
    expect(core.stats().pendingRequests).toBe(1);
    core.receive({ type: "response", id: "r1", command: "get_state", success: true, data: 1 });
    expect(await answer).toEqual({
      type: "response",
      id: "r1",
      command: "get_state",
      success: true,
      data: 1,
    });
    expect(core.stats().pendingRequests).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("counts a response nobody asked for and logs it on powers of two, with the label", () => {
    for (let n = 0; n < 5; n++) core.receive({ type: "response", id: "zz", command: "x", success: true });
    expect(core.stats().unknownResponses).toBe(5);
    expect(logs).toEqual([
      { level: "warn", msg: "worker_response_unknown", fields: { pid: 7, unknown: 1 } },
      { level: "warn", msg: "worker_response_unknown", fields: { pid: 7, unknown: 2 } },
      { level: "warn", msg: "worker_response_unknown", fields: { pid: 7, unknown: 4 } },
    ]);
  });

  it("counts a record that does not parse and logs it on powers of two", () => {
    const garbage = [null, 5, { type: "ready" }, { type: "response" }, "text"];
    for (const raw of garbage) core.receive(raw);
    expect(core.stats().droppedRecords).toBe(5);
    expect(logs.map((entry) => [entry.msg, entry.fields])).toEqual([
      ["worker_record_dropped", { pid: 7, dropped: 1, recordType: "object" }],
      ["worker_record_dropped", { pid: 7, dropped: 2, recordType: "number" }],
      ["worker_record_dropped", { pid: 7, dropped: 4, recordType: "response" }],
    ]);
  });

  it("keeps delivering to the next listener when one throws, and counts the failure", () => {
    const seen: string[] = [];
    core.onRecord(() => {
      throw new Error("listener bug");
    });
    core.onRecord((record) => void seen.push(record.type));
    core.receive(ready);
    expect(seen).toEqual(["ready"]);
    expect(core.stats().listenerErrors).toBe(1);
    expect(logs).toMatchObject([
      { level: "error", msg: "worker_listener_failed", fields: { pid: 7, failures: 1 } },
    ]);
  });

  it("stops delivering to a listener that unsubscribed", () => {
    const seen: string[] = [];
    const off = core.onRecord((record) => void seen.push(record.type));
    off();
    core.receive(ready);
    expect(seen).toEqual([]);
  });

  it("clips the strings of a failed response", async () => {
    const answer = core.request({ type: "get_state" }, 5000, send);
    core.receive({
      type: "response",
      id: "r1",
      command: "get_state",
      success: false,
      error: "e".repeat(5000),
    });
    expect((await answer).error).toHaveLength(2049);
  });

  it("rejects with timeout when the clock runs out, and drops the late response as unknown", async () => {
    const answer = core.request({ type: "get_state" }, 1000, send);
    const outcome = expect(answer).rejects.toMatchObject({ code: "timeout" });
    await clock.advance(1000);
    await outcome;
    core.receive({ type: "response", id: "r1", command: "get_state", success: true });
    expect(core.stats()).toMatchObject({ unknownResponses: 1, pendingRequests: 0 });
  });

  it("waits without a deadline when the timeout is undefined", async () => {
    const answer = core.request({ type: "prompt", message: "x" }, undefined, send);
    expect(clock.pending()).toBe(0);
    core.receive({ type: "response", id: "r1", command: "prompt", success: true });
    expect((await answer).success).toBe(true);
  });

  it("rejects with worker_failed at once when the channel refuses the record", async () => {
    await expect(core.request({ type: "get_state" }, 5000, () => false)).rejects.toEqual(
      new PapError("worker_failed"),
    );
    expect(core.stats().pendingRequests).toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("failPending rejects every pending request with worker_failed and clears their timers", async () => {
    const first = core.request({ type: "get_state" }, 5000, send);
    const second = core.request({ type: "prompt", message: "x" }, undefined, send);
    const outcomes = Promise.all([
      expect(first).rejects.toEqual(new PapError("worker_failed")),
      expect(second).rejects.toEqual(new PapError("worker_failed")),
    ]);
    core.failPending();
    await outcomes;
    expect(core.stats().pendingRequests).toBe(0);
    expect(clock.pending()).toBe(0);
  });
});
