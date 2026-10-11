import { appendFileSync } from "node:fs";
import { ALL_PERMISSIONS, type Caller, type EventFrame } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { codeOf } from "./testing/helpers.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { createServiceBed } from "./testing/service-bed.ts";

const owner: Caller = { userId: "u1", permissions: new Set(ALL_PERMISSIONS) };
const confirm = {
  type: "extension_ui_request" as const,
  id: "d1",
  method: "confirm",
  title: "Run?",
  message: "bash: ls",
};
const user = (content: string) => ({ role: "user", content });

const build = () => createServiceBed({ createSessionsStore, createSessionsService });
let bed: ReturnType<typeof build>;
afterEach(() => bed.dispose());
const rowsOf = (event: unknown): string[] =>
  (event as { messages: Array<{ role: string; content: unknown }> }).messages.map((m) =>
    typeof m.content === "string" ? m.content : JSON.stringify(m.content),
  );

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
    expect(bed.service.snapshot("p1")).toEqual({
      kind: "snapshot",
      status: "idle",
      messages: [],
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
    const snapshot = bed.service.snapshot("p1");
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
    expect(rowsOf(bed.service.snapshot("p1"))).toEqual(["first", '[{"type":"text","text":"one"}]', "second"]);
    // ...then the entry lands in the file, and a snapshot must not show it twice.
    appendFileSync(
      file,
      `${JSON.stringify({ type: "message", id: "u1", parentId: "a0", timestamp: "2026-10-10T00:00:03.000Z", message: { ...user("second"), timestamp: 3 } })}\n`,
    );
    expect(rowsOf(bed.service.snapshot("p1"))).toEqual(["first", '[{"type":"text","text":"one"}]', "second"]);
    expect(bed.service.snapshot("p1")).toMatchObject({ status: "running" });
  });

  it("reads the whole file once the run has settled", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    bed.emit(0, { type: "message_end", message: user("hi") });
    bed.writePiFile(0, [["hi", "hello"]]);
    bed.emit(0, { type: "agent_settled", aborted: false });
    await bed.clock.advance(0);
    expect(rowsOf(bed.service.snapshot("p1"))).toEqual(["hi", '[{"type":"text","text":"hello"}]']);
    expect(bed.service.snapshot("p1")).toMatchObject({ status: "idle" });
  });

  it("holds a long transcript to the last 75 rows and to one frame", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.writePiFile(
      0,
      Array.from({ length: 100 }, (_, i) => [`question ${i}`, `answer ${i}`] as const),
    );
    bed.emit(0, { type: "turn_start" });
    const rows = rowsOf(bed.service.snapshot("p1"));
    expect(rows).toHaveLength(75);
    expect(rows.at(-1)).toBe('[{"type":"text","text":"answer 99"}]');

    const big = "x".repeat(400_000);
    bed.writePiFile(
      0,
      Array.from({ length: 10 }, (_, i) => [`${i}${big}`, `answer ${i}`] as const),
    );
    const snapshot = bed.service.snapshot("p1");
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThan(1024 * 1024 - 1024);
    expect(rowsOf(snapshot).at(-1)).toBe('[{"type":"text","text":"answer 9"}]');
  });
});

describe("the session stream", () => {
  it("starts a subscriber with the snapshot, then every event in order", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c1",
      sub: "s1",
      stream: "session",
      key: "p1",
      after: undefined,
      send: (f) => frames.push(f),
    });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.event).toMatchObject({ kind: "snapshot", status: "idle" });
    bed.emit(0, { type: "agent_start" });
    bed.spawned[0]?.emit(confirm);
    bed.service.respondDialog({ sessionId: "p1", dialogId: "d1", response: { confirmed: false } }, owner);
    expect(frames.slice(1).map((frame) => (frame.event as { kind: string }).kind)).toEqual([
      "status",
      "pi",
      "dialog_open",
      "dialog_closed",
    ]);
    expect(frames.map((frame) => frame.seq)).toEqual([0, 1, 2, 3, 4]);
  });

  it("lets a reconnecting client resume from its cursor with no snapshot", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    bed.emit(0, { type: "agent_start" });
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c1",
      sub: "s1",
      stream: "session",
      key: "p1",
      after: { epoch: "e1", seq: 2 },
      send: (f) => frames.push(f),
    });
    bed.emit(0, { type: "turn_start" });
    expect(frames.map((frame) => (frame.event as { kind: string }).kind)).toEqual(["pi"]);
    expect(frames[0]?.seq).toBe(3);
  });

  it("shows a crash to the subscriber with its cause", async () => {
    bed = build();
    await bed.service.create(bed.work, owner);
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c1",
      sub: "s1",
      stream: "session",
      key: "p1",
      after: undefined,
      send: (f) => frames.push(f),
    });
    bed.spawned[0]?.crash({ code: null, signal: "SIGKILL", cause: "killed" });
    await bed.clock.advance(0);
    expect(frames.at(-1)?.event).toEqual({
      kind: "status",
      status: "cold",
      cause: "Agent process killed (SIGKILL), possibly out of memory.",
    });
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
