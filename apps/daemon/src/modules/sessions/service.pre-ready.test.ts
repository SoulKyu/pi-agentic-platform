import { afterEach, describe, expect, it } from "vitest";
import { MAX_PRE_READY_EVENTS } from "./pre-ready-buffer.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const extensionError = (n: number) =>
  ({
    type: "extension_error",
    extensionPath: `/ext/${n}.ts`,
    event: "session_start",
    error: "boom",
  }) as const;
const audit = {
  type: "audit",
  entry: { toolCallId: "t1", tool: "bash", category: "exec", decision: "allow" },
} as const;

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());

const noticeTexts = (frames: ReadonlyArray<{ event: unknown }>) =>
  frames.flatMap(({ event }) => {
    const e = event as { kind?: string; text?: string };
    return e.kind === "notice" ? [e.text] : [];
  });

describe("what a new session's worker says before it is ready", () => {
  it("reaches a subscriber that resumes from the start of the stream, after the row is stored", async () => {
    bed = build({ start: () => ({ kind: "ready", before: [extensionError(1)] }) });
    await bed.service.create(bed.work, testCaller({ permissions: new Set() }));
    const frames = await bed.subscribe("p1", { epoch: bed.hub.epoch, seq: 0 });
    expect(noticeTexts(frames)).toEqual(["An extension failed during session_start."]);
    // The status at ready is not replayed: a snapshot carries it.
    expect(frames).toHaveLength(1);
  });

  it("hands the audit entries it held to the audit module, after the row exists", async () => {
    const delivered: Array<{ id: string; stored: boolean }> = [];
    bed = build({
      audit: {
        append: () => {},
        reserve: () => true,
        fromWorker: (session) => {
          delivered.push({ id: session.id, stored: bed.store.get(session.id) !== undefined });
          return null;
        },
      },
      start: () => ({ kind: "ready", before: [audit] }),
    });
    await bed.service.create(bed.work, testCaller({ permissions: new Set() }));
    expect(delivered).toEqual([{ id: "p1", stored: true }]);
    expect(bed.db.all("SELECT session_id, kind FROM session_events")).toEqual([]);
  });

  it("holds a bounded number of events and says how many it dropped", async () => {
    const { logger, lines } = captureLogger();
    // Questions are neither limited nor folded, so each one is an event of its own to hold.
    const flood = Array.from({ length: MAX_PRE_READY_EVENTS + 8 }, (_, n) => ({
      type: "extension_ui_request" as const,
      id: `q${n}`,
      method: "confirm",
      title: "Run?",
    }));
    bed = build({ logger, start: () => ({ kind: "ready", before: flood }) });
    await bed.service.create(bed.work, testCaller({ permissions: new Set() }));
    const frames = await bed.subscribe("p1", { epoch: bed.hub.epoch, seq: 0 });
    expect(frames.filter(({ event }) => (event as { kind?: string }).kind === "dialog_open")).toHaveLength(
      MAX_PRE_READY_EVENTS,
    );
    expect(lines.find((line) => line.msg === "session_start_events_dropped")).toMatchObject({
      sessionId: "p1",
      dropped: 8,
    });
  });

  it("leaves nothing behind when the start fails", async () => {
    bed = build({ start: () => ({ kind: "exit70" }) });
    await expect(bed.service.create(bed.work, testCaller({ permissions: new Set() }))).rejects.toThrow();
    expect(bed.hub.stats().channels).toBe(0);
    expect(bed.db.get("SELECT COUNT(*) AS n FROM session_events")).toEqual({ n: 0 });
  });

  it("does not change a reopened session, which publishes from the start", async () => {
    bed = build({
      start: (index) => (index === 1 ? { kind: "ready", before: [extensionError(2)] } : undefined),
    });
    await bed.service.create(bed.work, testCaller({ permissions: new Set() }));
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    const frames = await bed.subscribe("p1");
    expect(frames).toHaveLength(1);
    await bed.service.prompt({ sessionId: "p1", text: "hi" }, testCaller({ permissions: new Set() }));
    expect(noticeTexts(frames)).toEqual(["An extension failed during session_start."]);
  });
});

describe("recent notices in the snapshot", () => {
  it("hands start-up notices to a subscriber that has no cursor (roadmap: recent notices in the snapshot)", async () => {
    bed = build({ start: () => ({ kind: "ready", before: [extensionError(1)] }) });
    const { sessionId } = await bed.service.create(bed.work, testCaller({ permissions: new Set() }));
    const snapshot = await bed.snapshot(sessionId);
    expect(snapshot).toMatchObject({
      notices: [
        {
          level: "error",
          text: "An extension failed during session_start.",
          code: "extension_failed_during",
          params: { event: "session_start" },
        },
      ],
    });
  });
});
