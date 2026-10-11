import { appendFileSync } from "node:fs";
import { ALL_PERMISSIONS, type Caller, type EventFrame } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { codeOf } from "./testing/helpers.ts";
import { createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const confirm = {
  type: "extension_ui_request" as const,
  id: "d1",
  method: "confirm",
  title: "Run?",
  message: "bash: ls",
};
const user = (content: string) => ({ role: "user", content });
const system = { role: "system", content: "", sections: { preamble: "You are an expert coding assistant" } };

const build = (options?: Parameters<typeof createServiceBed>[1]) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());
const rowsOf = (event: unknown): string[] =>
  (event as { rows: Array<{ message: { role: string; content: unknown } }> }).rows.map(({ message: m }) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );
const kindsOf = (frames: EventFrame[]) => frames.map((frame) => (frame.event as { kind: string }).kind);

describe("snapshot", () => {
  it("is not_found for a session that does not exist, which keeps the hub from making channels at will (R79)", async () => {
    bed = build();
    expect(() => bed.service.snapshot("ghost")).toThrow(expect.objectContaining({ code: "not_found" }));
    const frames: EventFrame[] = [];
    const subscribe = () =>
      bed.hub.open({
        connectionId: "c1",
        sub: "s1",
        stream: "session",
        key: "ghost",
        after: undefined,
        send: (f) => frames.push(f),
      });
    expect(subscribe).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(bed.hub.stats()).toEqual({ channels: 0, subscriptions: 0 });
  });

  it("carries the status, the open dialogs and, for a draft, no messages", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.spawned[0]?.emit(confirm);
    expect(await bed.snapshot("p1")).toMatchObject({
      kind: "snapshot",
      status: "idle",
      rows: [],
      dialogs: [{ id: "d1", method: "confirm", title: "Run?", message: "bash: ls" }],
    });
  });

  it("reads the transcript from the file, also of a session without a worker", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.writePiFile(0, [["first", "one"]]);
    bed.emit(0, { type: "turn_start" });
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    const snapshot = await bed.snapshot("p1");
    expect(snapshot).toMatchObject({ status: "cold", dialogs: [] });
    expect(rowsOf(snapshot)).toEqual(["first", '[{"type":"text","text":"one"}]']);
  });

  it("keeps the messages of a run in progress, which the file does not have yet, and not twice (R38)", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const file = bed.writePiFile(0, [["first", "one"]]);
    bed.emit(0, { type: "turn_start" });
    bed.emit(0, { type: "agent_start" });
    // Pi's subscribers see the message before the file does...
    bed.emit(0, { type: "message_end", message: user("second") });
    expect(rowsOf(await bed.snapshot("p1"))).toEqual(["first", '[{"type":"text","text":"one"}]', "second"]);
    // ...then the entry lands in the file, and a snapshot must not show it twice.
    appendFileSync(
      file,
      `${JSON.stringify({ type: "message", id: "u1", parentId: "a0", timestamp: "2026-10-10T00:00:03.000Z", message: { ...user("second"), timestamp: 3 } })}\n`,
    );
    expect(rowsOf(await bed.snapshot("p1"))).toEqual(["first", '[{"type":"text","text":"one"}]', "second"]);
    expect(await bed.snapshot("p1")).toMatchObject({ status: "running" });
  });

  it("reads the whole file once the run has settled", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_end", message: user("hi") });
    bed.writePiFile(0, [["hi", "hello"]]);
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(rowsOf(await bed.snapshot("p1"))).toEqual(["hi", '[{"type":"text","text":"hello"}]']);
    expect(await bed.snapshot("p1")).toMatchObject({ status: "idle" });
  });

  it("never shows Pi's system prompt, in the file or in a run (R107)", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_end", message: system });
    bed.emit(0, { type: "message_end", message: user("hi") });
    expect(rowsOf(await bed.snapshot("p1"))).toEqual(["hi"]);
    bed.writePiFile(0, [["hi", "hello"]]);
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(JSON.stringify(await bed.snapshot("p1"))).not.toContain("expert coding assistant");
    expect(rowsOf(await bed.snapshot("p1"))).toHaveLength(2);
  });

  it("holds a long transcript to the last 75 rows", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.writePiFile(
      0,
      Array.from({ length: 100 }, (_, i) => [`question ${i}`, `answer ${i}`] as const),
    );
    bed.emit(0, { type: "turn_start" });
    const rows = rowsOf(await bed.snapshot("p1"));
    expect(rows).toHaveLength(75);
    expect(rows.at(-1)).toBe('[{"type":"text","text":"answer 99"}]');
  });

  it("shows a row too big for a snapshot as a placeholder, and the rows around it as they are (R109)", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const big = "x".repeat(400_000);
    bed.writePiFile(
      0,
      Array.from({ length: 10 }, (_, i) => [`${i}${big}`, `answer ${i}`] as const),
    );
    bed.emit(0, { type: "turn_start" });
    const snapshot = (await bed.snapshot("p1")) as {
      rows: Array<{ message: { role: string; omitted?: boolean } }>;
    };
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(1024 * 1024 - 1024);
    expect(snapshot.rows).toHaveLength(20);
    expect(snapshot.rows.filter((row) => row.message.omitted)).toHaveLength(10);
    expect(rowsOf(snapshot).at(-1)).toBe('[{"type":"text","text":"answer 9"}]');
  });

  it("is not empty when the newest row of a run is the big one (R109)", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.writePiFile(0, [["first", "one"]]);
    bed.emit(0, { type: "turn_start" });
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, {
      type: "message_end",
      message: { role: "assistant", timestamp: 5, content: "y".repeat(2_000_000) },
    });
    const snapshot = (await bed.snapshot("p1")) as {
      rows: Array<{ entryId: null; message: Record<string, unknown> }>;
    };
    expect(snapshot.rows).toHaveLength(3);
    expect(snapshot.rows.at(-1)).toEqual({
      entryId: null,
      message: expect.objectContaining({ role: "assistant", timestamp: 5, omitted: true }),
    });
  });
});

describe("preparing a read (R108)", () => {
  it("loads the transcript reader once, for whoever comes first and for the concurrent", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    expect(bed.transcript.loads).toBe(0);
    await Promise.all([
      bed.service.prepareSubscription("p1", owner),
      bed.service.prepareSubscription("p1", owner),
    ]);
    await bed.service.prepareSubscription("p1", owner);
    expect(bed.transcript.loads).toBe(1);
  });

  it("loads nothing for a caller who may not read, or for a session that is not there", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const stranger: Caller = { userId: "u2", permissions: new Set(ALL_PERMISSIONS) };
    expect(await codeOf(bed.service.prepareSubscription("p1", stranger))).toBe("not_found");
    expect(await codeOf(bed.service.prepareSubscription("ghost", owner))).toBe("not_found");
    expect(bed.transcript.loads).toBe(0);
  });

  it("tries again after a load that failed, and says internal meanwhile", async () => {
    bed = build({ readerFailures: 1 });
    await bed.service.create(bed.work, owner);
    await expect(bed.service.prepareSubscription("p1", owner)).rejects.toThrow("did not load");
    // The snapshot provider reads what has been loaded; with nothing loaded it must not invent an empty transcript.
    expect(() => bed.service.snapshot("p1")).toThrow(expect.objectContaining({ code: "internal" }));
    await bed.service.prepareSubscription("p1", owner);
    expect(bed.service.snapshot("p1")).toMatchObject({ kind: "snapshot" });
    expect(bed.transcript.loads).toBe(2);
  });
});

describe("the session stream", () => {
  it("starts a subscriber with the snapshot, then every event in order", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const frames = await bed.subscribe("p1");
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toMatchObject({ kind: "snapshot", status: "idle" });
    bed.emit(0, { type: "agent_start" });
    bed.spawned[0]?.emit(confirm);
    bed.service.respondDialog({ sessionId: "p1", dialogId: "d1", response: { confirmed: false } }, owner);
    expect(kindsOf(frames.slice(1))).toEqual(["status", "pi", "dialog_open", "dialog_closed"]);
    expect(frames.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("lets a reconnecting client resume from its cursor with no snapshot", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    const frames = await bed.subscribe("p1", { epoch: "e1", seq: 2 });
    bed.emit(0, { type: "turn_start" });
    expect(kindsOf(frames)).toEqual(["pi"]);
    expect(frames[0]?.seq).toBe(3);
  });

  it("shows a crash to the subscriber with its cause", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const frames = await bed.subscribe("p1");
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(frames.at(-1)?.event).toEqual({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
  });

  it("sends a subscriber no system prompt: no event, and no row in what it starts from (R107)", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const frames = await bed.subscribe("p1");
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_start", message: system });
    bed.emit(0, { type: "message_end", message: system });
    bed.emit(0, { type: "message_end", message: user("hi") });
    expect(JSON.stringify(frames)).not.toContain("expert coding assistant");
    expect(kindsOf(frames)).toEqual(["snapshot", "status", "pi", "pi"]);
  });
});

describe("what is recorded about a session", () => {
  it("keeps run boundaries, policy decisions and worker exits, in order, and only for sessions that exist", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.spawned[0]?.emit({
      type: "audit",
      entry: { toolCallId: "c1", tool: "bash", category: "exec", decision: "approved" },
    });
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    const kinds = bed.db
      .all<{ kind: string }>("SELECT kind FROM session_events ORDER BY id")
      .map((row) => row.kind);
    expect(kinds).toEqual(["run_start", "policy", "run_end", "worker_exit"]);
  });

  it("does not fail a command because an event could not be recorded", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.db.exec("DROP TABLE session_events");
    bed.emit(0, { type: "agent_start" });
    expect(bed.service.list(owner)[0]?.status).toBe("running");
    expect(await codeOf(bed.service.prompt({ sessionId: "p1", text: "go" }, owner))).toBeNull();
  });
});

describe("snapshot of a reply being written", () => {
  const text = (d: string) => ({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: d },
  });
  const deltaOf = (frame: EventFrame): string =>
    (frame.event as { event?: { assistantMessageEvent?: { delta?: string } } }).event?.assistantMessageEvent
      ?.delta ?? "";

  it("rebuilds the reply exactly from a snapshot taken between two flushes and the frames after it", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_start", message: { role: "assistant", content: [] } });
    bed.emit(0, text("a"));
    bed.emit(0, text("b"));
    await bed.clock.advance(50);
    bed.emit(0, text("c"));
    const frames = await bed.subscribe(sessionId);
    bed.emit(0, text("d"));
    await bed.clock.advance(50);
    const snapshot = frames[0]?.event as { kind: string; partial: { blocks: Array<{ text: string }> } };
    expect(snapshot.kind).toBe("snapshot");
    expect(snapshot.partial.blocks[0]?.text).toBe("ab");
    expect(frames.slice(1).map(deltaOf).join("")).toBe("cd");
  });

  it("rebuilds the reply exactly when a message_end flushes the pending deltas after the snapshot", async () => {
    bed = build();
    const { sessionId } = await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_start", message: { role: "assistant", content: [] } });
    bed.emit(0, text("a"));
    const frames = await bed.subscribe(sessionId);
    bed.emit(0, text("b"));
    bed.emit(0, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "ab" }] },
    });
    const snapshot = frames[0]?.event as { partial: { blocks: Array<{ text: string }> } | null };
    expect(snapshot.partial?.blocks[0]?.text ?? "").toBe("");
    expect(frames.slice(1).map(deltaOf).join("")).toBe("ab");
    expect((await bed.snapshot(sessionId)) as { partial: unknown }).toMatchObject({ partial: null });
  });
});
