import { ERROR_MESSAGES, PapError, type SnapshotEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options: BedOptions = {}) => {
  bed = build(options);
};
afterEach(() => bed.dispose());

const sent = (index = 0) => bed.spawned[index]?.requests.map((request) => request.type);
const READY = (index: number) =>
  ({
    type: "ready",
    sessionId: `pi-${index}`,
    sessionFile: `${bed.agentDir}/sessions/--w--/pi-${index}.jsonl`,
    piVersion: "1.1.0",
    leafId: null,
    sessionName: null,
  }) as const;

describe("the busy rule (M2R88)", () => {
  it("refuses to navigate or compact while the session runs", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.emit(0, { type: "agent_start" });
    await expect(bed.service.navigate({ sessionId, targetId: "a0" }, OWNER)).rejects.toThrow(
      new PapError("session_busy"),
    );
    await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_busy"));
    expect(sent()).toEqual([]);
  });

  it("is busy while a prompt waits for its agent_start and while a compaction is in flight (M2-RT-08, M2-RT-34)", async () => {
    open({ replies: { prompt: "held", compact: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    void bed.service.prompt({ sessionId, text: "go" }, OWNER).catch(() => undefined);
    await bed.clock.advance(0);
    // Pi has the prompt, no agent_start yet: the status still says idle, the session is busy all the same.
    await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_busy"));
    await expect(bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).rejects.toThrow(
      new PapError("session_busy"),
    );
    bed.answerHeld(0, "prompt", { data: { disposition: "handled" } });
    await bed.clock.advance(0);
    void bed.service.compact({ sessionId }, OWNER).catch(() => undefined);
    await bed.clock.advance(0);
    await expect(bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).rejects.toThrow(
      new PapError("session_busy"),
    );
    await expect(bed.service.prompt({ sessionId, text: "now" }, OWNER)).rejects.toThrow(
      new PapError("session_busy"),
    );
    expect(sent()).toEqual(["prompt", "compact"]);
  });

  it("is busy after a prompt answered started and before its agent_start", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("session_busy"));
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(await bed.service.compact({ sessionId }, OWNER)).toEqual({
      tokensBefore: 10,
      estimatedTokensAfter: 5,
    });
  });

  it("is busy while a navigation is in flight, and a prompt then waits for it too", async () => {
    open({ replies: { navigate_tree: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    void bed.service.navigate({ sessionId, targetId: "u0" }, OWNER).catch(() => undefined);
    await bed.clock.advance(0);
    await expect(bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).rejects.toThrow(
      new PapError("session_busy"),
    );
    await expect(bed.service.prompt({ sessionId, text: "now" }, OWNER)).rejects.toThrow(
      new PapError("session_busy"),
    );
    expect(sent()).toEqual(["navigate_tree"]);
  });

  it("is free again once a compaction was refused or the worker died", async () => {
    open({ replies: { compact: { success: false, error: "No API key found for x." } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("command_failed"));
    await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError("command_failed"));
    expect(sent()).toEqual(["compact", "compact"]);
  });

  describe("with the worker being brought up (ensureLive held open)", () => {
    const openCold = async () => {
      open({
        replies: { compact: "held", prompt: "held" },
        start: (index) => (index === 0 ? undefined : { kind: "silent" }),
      });
      const { sessionId } = await bed.service.create(bed.work, OWNER);
      bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
      await bed.clock.advance(0);
      return sessionId;
    };

    it.each([
      ["compact first", ["compact", "prompt"]],
      ["prompt first", ["prompt", "compact"]],
    ] as const)(
      "sends only one of a compact and a prompt that wait for the same worker (%s)",
      async (_name, order) => {
        const sessionId = await openCold();
        const call = {
          compact: () => bed.service.compact({ sessionId }, OWNER),
          prompt: () => bed.service.prompt({ sessionId, text: "go" }, OWNER),
        };
        const outcomes: Record<string, string> = {};
        for (const name of order) {
          void call[name]().then(
            () => (outcomes[name] = "sent"),
            (error: PapError) => (outcomes[name] = error.code),
          );
        }
        await bed.clock.advance(0);
        expect(bed.spawned).toHaveLength(2);
        bed.spawned[1]?.emit(READY(1));
        // The request that was sent stays held; the other is refused.
        await vi.waitFor(() => expect(Object.keys(outcomes)).toHaveLength(1), { timeout: 2000 });
        const [refused] = Object.keys(outcomes);
        expect(outcomes[refused ?? ""]).toBe("session_busy");
        expect(sent(1)).toEqual([order.find((name) => name !== refused)]);
      },
    );

    it("refuses the prompt that arrives while a compaction waits for its worker", async () => {
      const sessionId = await openCold();
      void bed.service.compact({ sessionId }, OWNER).catch(() => undefined);
      await bed.clock.advance(0);
      const prompted = bed.service.prompt({ sessionId, text: "go" }, OWNER).then(
        () => "sent",
        (error: PapError) => error.code,
      );
      bed.spawned[1]?.emit(READY(1));
      expect(await prompted).toBe("session_busy");
      expect(sent(1)).toEqual(["compact"]);
    });

    it("refuses the compaction that arrives while a prompt waits for its worker", async () => {
      const sessionId = await openCold();
      void bed.service.prompt({ sessionId, text: "go" }, OWNER).catch(() => undefined);
      await bed.clock.advance(0);
      const compacted = bed.service.compact({ sessionId }, OWNER).then(
        () => "sent",
        (error: PapError) => error.code,
      );
      bed.spawned[1]?.emit(READY(1));
      expect(await compacted).toBe("session_busy");
      expect(sent(1)).toEqual(["prompt"]);
    });
  });
});

describe("activity in the snapshot", () => {
  it("shows a compaction or a retry in progress, and nothing once the worker is gone", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.snapshot(sessionId)).toMatchObject({ activity: { compacting: false, retry: null } });
    bed.emit(0, { type: "compaction_start", reason: "threshold" });
    expect(await bed.snapshot(sessionId)).toMatchObject({ activity: { compacting: true, retry: null } });
    bed.emit(0, { type: "compaction_end", reason: "threshold", aborted: false, willRetry: false });
    bed.emit(0, { type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 1, errorMessage: "x" });
    expect(await bed.snapshot(sessionId)).toMatchObject({
      activity: { compacting: false, retry: { attempt: 2, maxAttempts: 3 } },
    });
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(await bed.snapshot(sessionId)).toMatchObject({ activity: { compacting: false, retry: null } });
  });
});

describe("navigate", () => {
  it("moves the leaf and publishes a fresh snapshot of the new branch", async () => {
    open({ replies: { navigate_tree: { data: { cancelled: false, leafId: "a0", editorText: "q1" } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0, [
      ["q0", "r0"],
      ["q1", "r1"],
    ]);
    const frames = await bed.subscribe(sessionId);
    expect(await bed.service.navigate({ sessionId, targetId: "u1" }, OWNER)).toEqual({
      cancelled: false,
      editorText: "q1",
    });
    const snapshot = frames.at(-1)?.event as SnapshotEvent;
    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.leafId).toBe("a0");
    expect(snapshot.rows.map((row) => row.entryId)).toEqual(["u0", "a0"]);
    expect(frames.filter((frame) => (frame.event as { kind: string }).kind === "snapshot")).toHaveLength(2);
    expect(sent()).toEqual(["navigate_tree"]);
  });

  it("publishes no snapshot when Pi cancelled the navigation", async () => {
    open({ replies: { navigate_tree: { data: { cancelled: true, leafId: "a1" } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0);
    const frames = await bed.subscribe(sessionId);
    expect(await bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).toEqual({ cancelled: true });
    expect(frames).toHaveLength(1);
  });

  it("cuts an editor text to the contract's length", async () => {
    open({
      replies: {
        navigate_tree: { data: { cancelled: false, leafId: null, editorText: "a".repeat(300_000) } },
      },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const answer = await bed.service.navigate({ sessionId, targetId: "u0" }, OWNER);
    expect(answer.editorText).toBe("a".repeat(200_000));
  });

  it("cuts an editor text that would not fit one frame once escaped", async () => {
    const editorText = "\u0001".repeat(200_000);
    open({ replies: { navigate_tree: { data: { cancelled: false, leafId: null, editorText } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const answer = await bed.service.navigate({ sessionId, targetId: "u0" }, OWNER);
    // (800 000 - 2 quotes) / 6 bytes per escaped character.
    expect(answer.editorText).toBe("\u0001".repeat(133_333));
    expect(Buffer.byteLength(JSON.stringify(answer.editorText))).toBe(799_999 + 1);
  });

  it("answers success with a notice when the view cannot be refreshed after Pi moved", async () => {
    const { logger, lines } = captureLogger();
    open({ logger, replies: { navigate_tree: { data: { cancelled: false, leafId: "a0" } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0);
    const frames = await bed.subscribe(sessionId);
    const publish = bed.hub.publish.bind(bed.hub);
    const spy = vi.spyOn(bed.hub, "publish").mockImplementation((stream, key, event) => {
      if ((event as { kind: string }).kind === "snapshot") throw new Error("cannot build");
      return publish(stream, key, event);
    });
    expect(await bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).toEqual({ cancelled: false });
    spy.mockRestore();
    const kinds = frames.map((frame) => (frame.event as { kind: string }).kind);
    expect(kinds).toEqual(["snapshot", "notice"]);
    expect(frames.at(-1)?.event).toMatchObject({
      level: "warning",
      text: expect.stringContaining("Reload the page"),
    });
    expect(lines.some((line) => line.msg === "navigate_snapshot_failed")).toBe(true);
  });

  it("treats a leaf the contract cannot carry as unknown, in the answer's snapshot too", async () => {
    open({ replies: { navigate_tree: { data: { cancelled: false, leafId: "x".repeat(129) } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0);
    const frames = await bed.subscribe(sessionId);
    await bed.service.navigate({ sessionId, targetId: "u0" }, OWNER);
    expect((frames.at(-1)?.event as SnapshotEvent).leafId).toBe("a0");
  });

  it("refuses a worker's answer that is not an object, and tells the client to reload", async () => {
    open({ replies: { navigate_tree: { data: "yes" } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.writePiFile(0);
    const frames = await bed.subscribe(sessionId);
    await expect(bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)).rejects.toThrow(
      new PapError("command_failed"),
    );
    // Pi may have moved: the client must not keep a branch that is stale.
    expect(frames.map((frame) => (frame.event as { kind: string }).kind)).toEqual(["snapshot", "notice"]);
    expect(frames.at(-1)?.event).toMatchObject({ text: expect.stringContaining("Reload the page") });
  });

  it("is the owner's: a stranger and an unknown session get not_found and no worker hears of it", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const stranger = { ...OWNER, userId: "u2" };
    await expect(bed.service.navigate({ sessionId, targetId: "u0" }, stranger)).rejects.toThrow(
      new PapError("not_found"),
    );
    await expect(bed.service.compact({ sessionId: "nope" }, OWNER)).rejects.toThrow(
      new PapError("not_found"),
    );
    expect(sent()).toEqual([]);
  });
});

describe("Stop on a navigation or compaction that never answers", () => {
  it.each(["navigate_tree", "compact"] as const)(
    "stops the worker, rejects the held %s, and the next prompt runs on a fresh worker",
    async (type) => {
      open({ replies: { [type]: "held" } });
      const { sessionId } = await bed.service.create(bed.work, OWNER);
      const held = (
        type === "compact"
          ? bed.service.compact({ sessionId }, OWNER)
          : bed.service.navigate({ sessionId, targetId: "u0" }, OWNER)
      ).then(
        () => "answered",
        (error: PapError) => error.code,
      );
      await bed.clock.advance(0);
      await expect(bed.service.prompt({ sessionId, text: "go" }, OWNER)).rejects.toThrow(
        new PapError("session_busy"),
      );
      await bed.service.abort(sessionId, OWNER);
      expect(bed.spawned[0]?.stopped()).toBe(true);
      expect(await held).toBe("worker_failed");
      await bed.clock.advance(0);
      expect(await bed.service.prompt({ sessionId, text: "again" }, OWNER)).toEqual({
        disposition: "started",
      });
      expect(bed.spawned).toHaveLength(2);
      expect(sent(1)).toEqual(["prompt"]);
    },
  );
});

describe("compact", () => {
  it("returns what Pi measured, and sends the instructions", async () => {
    open({ replies: { compact: { data: { tokensBefore: 1234, estimatedTokensAfter: null } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.compact({ sessionId, customInstructions: "keep the API notes" }, OWNER)).toEqual(
      {
        tokensBefore: 1234,
        estimatedTokensAfter: null,
      },
    );
    expect(bed.spawned[0]?.requests[0]).toMatchObject({
      type: "compact",
      customInstructions: "keep the API notes",
    });
  });

  it.each([
    ["Nothing to compact (session too small)", "session_empty"],
    ["No API key found for x.", "command_failed"],
  ])("maps a refused compaction (%s) to %s", async (error, code) => {
    open({ replies: { compact: { success: false, error } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.compact({ sessionId }, OWNER)).rejects.toThrow(new PapError(code as never));
  });

  it("answers numbers it can carry when the worker's answer is malformed, and says so in the log", async () => {
    const { logger, lines } = captureLogger();
    open({ logger, replies: { compact: { data: { tokensBefore: "many" } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.compact({ sessionId }, OWNER)).toEqual({
      tokensBefore: 0,
      estimatedTokensAfter: null,
    });
    expect(lines.some((line) => line.msg === "compact_answer_unreadable")).toBe(true);
  });
  it("reads a fractional tokensBefore as unreadable, never as a count (M4R3)", async () => {
    const { logger, lines } = captureLogger();
    open({ logger, replies: { compact: { data: { tokensBefore: 1.5, estimatedTokensAfter: 5 } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.compact({ sessionId }, OWNER)).toMatchObject({ tokensBefore: 0 });
    expect(lines.some((line) => line.msg === "compact_answer_unreadable")).toBe(true);
  });

  it("never hands a client what the worker said when it refused (R66, M2R87)", async () => {
    const { logger, lines } = captureLogger();
    const hostile = `${"A".repeat(5000)} <script>alert(1)</script> /home/ubuntu/.pi/agent/auth.json sk-secret`;
    open({
      logger,
      replies: {
        compact: { success: false, error: hostile },
        navigate_tree: { success: false, error: hostile },
      },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    for (const run of [
      () => bed.service.compact({ sessionId }, OWNER),
      () => bed.service.navigate({ sessionId, targetId: "u0" }, OWNER),
    ]) {
      const error = await run().then(
        () => null,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PapError);
      expect((error as PapError).code).toBe("command_failed");
      expect((error as PapError).message).toBe(ERROR_MESSAGES.command_failed);
      expect(JSON.stringify(error)).not.toContain("sk-secret");
    }
    const refusals = lines.filter((line) => line.msg === "command_refused");
    expect(refusals.map((line) => line.command)).toEqual(["compact", "navigate_tree"]);
    for (const line of refusals) {
      expect(String(line.error).length).toBeLessThanOrEqual(2001);
      expect(String(line.error)).toBe(`${hostile.slice(0, 2000)}…`);
    }
  });
});
