import { PapError, type SessionAppend } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import { SHUTDOWN_GRACE_MS, SIGTERM_GRACE_MS } from "../../kernel/supervisor/kill-ladder.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { type MirrorPort, type Wire, createVmWorker, type VmWorker } from "./vm-worker.ts";

let clock: FakeClock;
let frames: unknown[];
let signals: string[];
let closed: number;
let wireOpen: boolean;
let sentTexts: string[];
let mirrorResult: ReturnType<MirrorPort["onSessionAppend"]>;
let appended: SessionAppend[];
let worker: VmWorker;
const log = captureLogger();

const wire: Wire = {
  send(frame) {
    if (!wireOpen) return false;
    frames.push(frame);
    return true;
  },
  close() {
    closed++;
  },
};
const mirror: MirrorPort = {
  path: "/home/pap/.mirrors/a/s.jsonl",
  facts: () => ({ size: 10, lastEntryId: "e1" }),
  onSessionAppend(append) {
    appended.push(append);
    return mirrorResult;
  },
};
const append = (overrides: Partial<SessionAppend> = {}): SessionAppend => ({
  type: "session_append",
  file: "s.jsonl",
  offset: 0,
  data: "e30=",
  replace: false,
  ...overrides,
});

function make(
  options: {
    mirror?: MirrorPort | null;
    reported?: { file: string | null; size: number; lastEntryId: string | null };
  } = {},
) {
  const input = {
    sessionFile: null,
    sessionsDir: "/agent/.pi/sessions",
    mirrorFor: vi.fn((): MirrorPort | "refused" => mirror),
    sent: (text: string) => void sentTexts.push(text),
  };
  worker = createVmWorker({
    clock,
    logger: log.logger,
    label: { slot: "s" },
    input,
    wire,
    mirror: options.mirror ?? null,
    reported: options.reported ?? { file: null, size: 0, lastEntryId: null },
    signal: (signal) => void signals.push(signal),
  });
  return input;
}

beforeEach(() => {
  clock = createFakeClock();
  frames = [];
  signals = [];
  closed = 0;
  wireOpen = true;
  sentTexts = [];
  appended = [];
  mirrorResult = "ok";
  log.lines.length = 0;
});

describe("sending", () => {
  it("records prompt, steer and follow-up texts before it sends them (R32)", () => {
    make();
    const order: string[] = [];
    const orderedWire = wire.send;
    wire.send = (frame) => {
      order.push(`wire:${(frame as { type: string }).type}`);
      return orderedWire(frame);
    };
    const handle = worker.handle;
    handle.send({ type: "prompt", id: "r1", message: "hello" });
    handle.send({ type: "prompt", id: "r2", message: "steer me", streamingBehavior: "steer" });
    handle.send({ type: "prompt", id: "r3", message: "later", streamingBehavior: "followUp" });
    handle.send({ type: "abort", id: "r4" });
    wire.send = orderedWire;
    expect(sentTexts).toEqual(["hello", "steer me", "later"]);
    expect(frames).toHaveLength(4);
    expect(order).toEqual(["wire:prompt", "wire:prompt", "wire:prompt", "wire:abort"]);
  });

  it("answers false when the frame cannot be written, and when the worker is gone", () => {
    make();
    wireOpen = false;
    expect(worker.handle.send({ type: "get_state", id: "r1" })).toBe(false);
    wireOpen = true;
    worker.wireClosed();
    expect(worker.handle.send({ type: "get_state", id: "r1" })).toBe(false);
  });

  it("keeps the handle alive when a frame is over the bound (RangeError): send is false", () => {
    make();
    const huge = "x".repeat(5 * 1024 * 1024);
    const real = wire.send;
    wire.send = () => {
      throw new RangeError("frame too large");
    };
    expect(worker.handle.send({ type: "prompt", id: "r1", message: huge })).toBe(false);
    wire.send = real;
    expect(worker.handle.send({ type: "get_state", id: "r2" })).toBe(true);
  });

  it("clamps a shutdown grace like a process worker", () => {
    make();
    worker.handle.send({ type: "shutdown", graceMs: 10 * 60_000 });
    expect(frames).toEqual([{ type: "shutdown", graceMs: 30_000 }]);
  });

  it("requests through the core: the response with the id resolves it, a dead worker rejects it", async () => {
    make();
    const answer = worker.handle.request({ type: "get_state" });
    expect(frames).toEqual([{ type: "get_state", id: "r1" }]);
    worker.receive({ type: "response", id: "r1", command: "get_state", success: true });
    expect(await answer).toMatchObject({ id: "r1", success: true });
    const waiting = worker.handle.request({ type: "get_state" });
    worker.wireClosed();
    await expect(waiting).rejects.toEqual(new PapError("worker_failed"));
  });

  it("delivers records to listeners", () => {
    make();
    const seen: string[] = [];
    worker.handle.onRecord((record) => void seen.push(record.type));
    worker.receive({ type: "leaf", leafId: null, resync: false });
    expect(seen).toEqual(["leaf"]);
  });
});

describe("the session mirror", () => {
  it("sends a resync at once when the mirror is not what the worker reported", () => {
    make({ mirror, reported: { file: "s.jsonl", size: 4, lastEntryId: "x" } });
    expect(frames).toEqual([{ type: "session_resync", fromOffset: 10, lastEntryId: "e1" }]);
  });

  it("sends nothing when the mirror and the worker agree", () => {
    make({ mirror, reported: { file: "s.jsonl", size: 10, lastEntryId: "e1" } });
    expect(frames).toEqual([]);
    expect(worker.handle.piFile()).toBe("/home/pap/.mirrors/a/s.jsonl");
  });

  it("opens the mirror of a new session at its first append and feeds it, never to the listeners", () => {
    const input = make();
    const seen: string[] = [];
    worker.handle.onRecord((record) => void seen.push(record.type));
    expect(worker.handle.piFile()).toBeNull();
    worker.receive(append());
    worker.receive(append({ offset: 3 }));
    expect(input.mirrorFor).toHaveBeenCalledTimes(1);
    expect(input.mirrorFor).toHaveBeenCalledWith("s.jsonl");
    expect(appended.map((entry) => entry.offset)).toEqual([0, 3]);
    expect(seen).toEqual([]);
    expect(worker.handle.piFile()).toBe("/home/pap/.mirrors/a/s.jsonl");
  });

  it("sends the resync the mirror asks for", () => {
    make();
    const resync = { type: "session_resync" as const, fromOffset: 0, lastEntryId: null };
    mirrorResult = { resync };
    worker.receive(append());
    expect(frames).toEqual([resync]);
  });

  it("ends the worker when the mirror refuses an append, or a new file opens a second mirror", async () => {
    make();
    mirrorResult = "refused";
    worker.receive(append());
    expect(closed).toBe(1);
    expect(signals).toEqual(["SIGKILL"]);
    expect((await worker.handle.exited).cause).toBe("exit_code");
    make();
    mirrorResult = "ok";
    worker.receive(append());
    worker.receive(append({ file: "other.jsonl" }));
    expect(closed).toBe(2);
  });

  it("ends the worker when the mirror of a first append is refused", () => {
    const input = make();
    input.mirrorFor.mockReturnValue("refused");
    worker.receive(append());
    expect(closed).toBe(1);
  });

  it("counts a malformed append as a dropped record", () => {
    make();
    worker.receive({ type: "session_append", file: "../x" });
    expect(worker.handle.stats().droppedRecords).toBe(1);
    expect(appended).toEqual([]);
  });
});

describe("exit and stop", () => {
  it("resolves exited from the guest's report, with the cause classifyExit gives, and its tail", async () => {
    make();
    worker.guestExited({ code: null, signal: "SIGTERM", cause: "signal" }, "bye");
    expect(await worker.handle.exited).toEqual({ code: null, signal: "SIGTERM", cause: "signal" });
    expect(worker.handle.outputTail()).toBe("bye");
    expect(closed).toBe(1);
    worker.guestExited({ code: 0, signal: null, cause: "clean" }, "later");
    expect(worker.handle.outputTail()).toBe("bye");
  });

  it("resolves exited from the wire's close when the guest said nothing, and the guest's report after it changes nothing", async () => {
    make();
    worker.wireClosed();
    expect((await worker.handle.exited).cause).toBe("exit_code");
    worker.guestExited({ code: 0, signal: null, cause: "clean" }, "late");
    expect(worker.handle.outputTail()).toBe("");
  });

  it("stops by the ladder: shutdown first, SIGTERM then SIGKILL to the guest on the existing timings", async () => {
    make();
    const stopping = worker.handle.stop();
    expect(frames).toEqual([{ type: "shutdown", graceMs: 1500 }]);
    await clock.advance(SHUTDOWN_GRACE_MS);
    expect(signals).toEqual(["SIGTERM"]);
    await clock.advance(SIGTERM_GRACE_MS);
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    await clock.advance(5000);
    expect((await stopping).cause).toBe("killed");
    expect(await worker.handle.stop()).toEqual(await worker.handle.exited);
  });

  it("stops at the shutdown rung when the worker exits in time", async () => {
    make();
    const stopping = worker.handle.stop();
    worker.guestExited({ code: 0, signal: null, cause: "clean" }, "");
    expect((await stopping).cause).toBe("clean");
    expect(signals).toEqual([]);
  });

  it("has no pid", () => {
    make();
    expect(worker.handle.pid).toBeUndefined();
  });
});
