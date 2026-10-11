import { PapError, SessionSummary } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options: BedOptions = {}) => {
  bed = build(options);
};
afterEach(() => bed.dispose());

const OTHER = { ...OWNER, userId: "u2" };
const sent = (index = 0) => bed.spawned[index]?.requests.map((request) => request.type);

describe("rename and auto-name", () => {
  it("maps a refused auto-name to session_empty", async () => {
    open({ replies: { auto_name: { success: false, error: "nothing to name" } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.autoName(sessionId, OWNER)).rejects.toThrow(new PapError("session_empty"));
  });

  it("never returns Pi's text for any other refusal", async () => {
    open({ replies: { auto_name: { success: false, error: "No API key for provider x" } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.autoName(sessionId, OWNER)).rejects.toThrow(new PapError("command_failed"));
  });

  it("answers the clipped title", async () => {
    open({ replies: { auto_name: { data: { title: "  Fix‮ the login  " } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.autoName(sessionId, OWNER)).toEqual({ name: "Fix the login" });
  });

  it("is command_failed when the worker's title is unreadable", async () => {
    open({ replies: { auto_name: { data: { title: 12 } } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await expect(bed.service.autoName(sessionId, OWNER)).rejects.toThrow(new PapError("command_failed"));
  });

  it("stores a clipped name from rename, from Pi's session_info_changed and from ready, and lists it", async () => {
    open({ replies: { set_session_name: { data: undefined } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.rename({ sessionId, name: "  Fix login  " }, OWNER);
    expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "set_session_name", name: "Fix login" });
    bed.emit(0, { type: "session_info_changed", name: `Fix the login bug ${"x".repeat(400)}` });
    expect(bed.service.list(OWNER)[0]?.name).toHaveLength(256);
    expect(SessionSummary.array().parse(bed.service.list(OWNER))).toHaveLength(1);
  });

  it("keeps a hostile name from ever making sessions.list fail", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const hostile = [
      "😀".repeat(400),
      `‮${"\u0000".repeat(50)}${"é".repeat(300)}`,
      "\ud800".repeat(300),
      `${"a".repeat(255)}\u{1F600}`,
    ];
    for (const name of hostile) {
      bed.emit(0, { type: "session_info_changed", name });
      expect(() => SessionSummary.array().parse(bed.service.list(OWNER))).not.toThrow();
      expect(bed.db.get("SELECT name FROM sessions WHERE id = $id", { id: sessionId })).toBeDefined();
    }
    expect(bed.service.list(OWNER)[0]?.name).toBe(`${"a".repeat(255)}\u{1F600}`);
    bed.emit(0, { type: "session_info_changed" });
    expect(bed.service.list(OWNER)[0]?.name).toBeNull();
  });

  it("reads the name in ready (clipped) and lists it for a session reopened cold", async () => {
    open({ start: () => ({ kind: "ready", sessionName: "N".repeat(300) }) });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(bed.service.list(OWNER)[0]?.name).toBe("N".repeat(256));
    const snapshot = await bed.snapshot(sessionId);
    expect(snapshot).toMatchObject({ kind: "snapshot", name: "N".repeat(256) });
  });

  it("publishes a name event once, not a raw Pi event", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    bed.emit(0, { type: "session_info_changed", name: "Login fix" });
    const kinds = frames.map((frame) => (frame.event as { kind: string }).kind);
    expect(kinds).toEqual(["snapshot", "name"]);
    expect(frames.at(-1)?.event).toEqual({ kind: "name", name: "Login fix" });
  });

  it("starts the worker of a cold session for a rename (the single-writer rule, M2R93)", async () => {
    open({ replies: { set_session_name: { data: undefined } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(bed.service.list(OWNER)[0]?.status).toBe("cold");
    await bed.service.rename({ sessionId, name: "Again" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
    expect(sent(1)).toContain("set_session_name");
  });

  it("allows a rename while the session runs (a name is a file append, not a branch change)", async () => {
    open({ replies: { set_session_name: { data: undefined } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.emit(0, { type: "agent_start" });
    await bed.service.rename({ sessionId, name: "During" }, OWNER);
    expect(sent()).toEqual(["set_session_name"]);
  });

  it("refuses a name with nothing in it, and another user's session", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    for (const name of ["", "  ", "‮​"]) {
      await expect(bed.service.rename({ sessionId, name }, OWNER)).rejects.toThrow(
        new PapError("bad_request"),
      );
    }
    await expect(bed.service.rename({ sessionId, name: "x" }, OTHER)).rejects.toThrow(
      new PapError("not_found"),
    );
    await expect(bed.service.autoName(sessionId, OTHER)).rejects.toThrow(new PapError("not_found"));
    expect(sent()).toEqual([]);
  });

  it("shares one model call between two asks at once, and asks again afterwards", async () => {
    open({ replies: { auto_name: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const first = bed.service.autoName(sessionId, OWNER);
    const second = bed.service.autoName(sessionId, OWNER);
    await bed.clock.advance(0);
    expect(sent()).toEqual(["auto_name"]);
    bed.answerHeld(0, "auto_name", { data: { title: "One" } });
    expect(await first).toEqual({ name: "One" });
    expect(await second).toEqual({ name: "One" });
    const third = bed.service.autoName(sessionId, OWNER);
    await bed.clock.advance(0);
    bed.answerHeld(0, "auto_name", { data: { title: "Two" } });
    expect(await third).toEqual({ name: "Two" });
    expect(sent()).toEqual(["auto_name", "auto_name"]);
  });

  it("answers timeout when the worker does not answer, and sends the rename once (R105)", async () => {
    open({ replies: { set_session_name: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const refused = expect(bed.service.rename({ sessionId, name: "Slow" }, OWNER)).rejects.toThrow(
      new PapError("timeout"),
    );
    await bed.clock.advance(30_000);
    await refused;
    expect(sent()).toEqual(["set_session_name"]);
  });
});
