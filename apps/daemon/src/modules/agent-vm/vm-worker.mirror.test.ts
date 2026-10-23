import type { SessionAppend } from "@pap/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createVmWorker, type MirrorPort, type VmWorker, type Wire } from "./vm-worker.ts";

type Outcome =
  "ok" | "refused" | { resync: { type: "session_resync"; fromOffset: number; lastEntryId: string | null } };

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let events: string[];
let frames: unknown[];
let signals: string[];
let pending: Array<(outcome: Outcome) => void>;
let worker: VmWorker;
let mirrorClosed: number;
const log = captureLogger();

const wire: Wire = {
  send(frame) {
    frames.push(frame);
    return true;
  },
  close: () => void events.push("close"),
  pause: () => void events.push("pause"),
  resume: () => void events.push("resume"),
};
const append = (offset: number): SessionAppend => ({
  type: "session_append",
  file: "s.jsonl",
  offset,
  data: "e30=",
  replace: false,
});
/** A mirror whose append of offset 100 (a long line) is parsed in a thread and answered later. */
const mirror: MirrorPort = {
  path: "/m/s.jsonl",
  facts: () => ({ size: 0, lastEntryId: null }),
  onSessionAppend(record) {
    events.push(`append:${record.offset}`);
    if (record.offset !== 100) return "ok";
    return new Promise<Outcome>((resolve) => pending.push(resolve));
  },
  close: () => void mirrorClosed++,
};

function make() {
  worker = createVmWorker({
    clock: createFakeClock(),
    logger: log.logger,
    label: { slot: "s" },
    slot: "s",
    input: {
      sessionFile: "s.jsonl",
      sessionsDir: "/x",
      mirrorFor: () => mirror,
      unsent: () => false,
      sent: () => {},
    },
    wire,
    mirror,
    reported: { file: "s.jsonl", size: 0, lastEntryId: null },
    signal: (signal) => void signals.push(signal),
  });
  worker.handle.onRecord((record) => void events.push(`record:${record.type}`));
}

beforeEach(() => {
  events = [];
  frames = [];
  signals = [];
  pending = [];
  mirrorClosed = 0;
  log.lines.length = 0;
});

describe("a line parsed in the thread (R32: the connection is paused meanwhile)", () => {
  it("pauses the wire, holds every later frame in order, and replays them after the answer", async () => {
    make();
    worker.receive(append(100));
    worker.receive({ type: "leaf", leafId: "a", resync: false });
    worker.receive(append(150));
    worker.receive({ type: "leaf", leafId: "b", resync: false });
    expect(events).toEqual(["append:100", "pause"]);
    pending[0]?.("ok");
    await settle();
    expect(events).toEqual(["append:100", "pause", "record:leaf", "append:150", "record:leaf", "resume"]);
  });

  it("sends a resync the thread's answer asks for before it replays what was held", async () => {
    make();
    worker.receive(append(100));
    worker.receive({ type: "leaf", leafId: "a", resync: false });
    const resync = { type: "session_resync" as const, fromOffset: 7, lastEntryId: "e1" };
    pending[0]?.({ resync });
    await settle();
    expect(frames).toEqual([resync]);
    expect(events.at(-1)).toBe("resume");
  });

  it("ends the worker when the parse refuses the line, and never resumes", async () => {
    make();
    worker.receive(append(100));
    worker.receive({ type: "leaf", leafId: "a", resync: false });
    pending[0]?.("refused");
    await settle();
    expect(signals).toEqual(["SIGKILL"]);
    expect(events).toContain("close");
    expect(events).not.toContain("resume");
    expect(events).not.toContain("record:leaf");
    expect((await worker.handle.exited).cause).toBe("exit_code");
  });

  it("re-pauses when a held frame is another long line, and resumes only at the end", async () => {
    make();
    worker.receive(append(100));
    worker.receive({ type: "leaf", leafId: "a", resync: false });
    worker.receive(append(100));
    pending[0]?.("ok");
    await settle();
    expect(events.filter((event) => event === "resume")).toEqual([]);
    expect(pending).toHaveLength(2);
    pending[1]?.("ok");
    await settle();
    expect(events.at(-1)).toBe("resume");
  });

  it("drops the answer when the connection closed meanwhile, and closes the mirror once", async () => {
    make();
    worker.receive(append(100));
    worker.guestGone();
    worker.wireClosed();
    expect(mirrorClosed).toBe(1);
    pending[0]?.("ok");
    await settle();
    expect(events).not.toContain("resume");
    expect(mirrorClosed).toBe(1);
  });

  it("refuses a worker that floods frames while it is paused", () => {
    make();
    worker.receive(append(100));
    for (let i = 0; i < 300; i++) worker.receive({ type: "leaf", leafId: String(i), resync: false });
    expect(signals).toEqual(["SIGKILL"]);
  });

  it("a mirror that throws ends the worker", async () => {
    make();
    pending = [];
    const failing: MirrorPort = {
      ...mirror,
      onSessionAppend: () => Promise.reject(new Error("thread died")),
    };
    worker = createVmWorker({
      clock: createFakeClock(),
      logger: log.logger,
      label: {},
      slot: "s",
      input: {
        sessionFile: "s.jsonl",
        sessionsDir: "/x",
        mirrorFor: () => failing,
        unsent: () => false,
        sent: () => {},
      },
      wire,
      mirror: failing,
      reported: { file: "s.jsonl", size: 0, lastEntryId: null },
      signal: (signal) => void signals.push(signal),
    });
    worker.receive(append(0));
    await settle();
    expect(signals).toEqual(["SIGKILL"]);
  });
});

describe("closing the mirror", () => {
  it("is done once when the worker ends by the guest's report", () => {
    make();
    worker.guestExited({ code: 0, signal: null, cause: "clean" }, "");
    worker.guestGone();
    worker.wireClosed();
    expect(mirrorClosed).toBe(1);
  });
});
