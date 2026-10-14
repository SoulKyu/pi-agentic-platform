import { ERROR_MESSAGES, PapError } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { captureLogger, codeOf } from "./testing/helpers.ts";
import { type BedOptions, createServiceBed, OWNER } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";
import { testCaller } from "../../testing/caller.ts";

const build = (options: BedOptions = {}) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
const open = (options: BedOptions = {}) => {
  bed = build(options);
};
afterEach(() => bed.dispose());

const plain = { provider: "faux", id: "plain", name: "Plain", reasoning: false };
const thinker = { provider: "faux", id: "thinker", name: "Thinker", reasoning: true, contextWindow: 200_000 };
const loadout = (overrides: Record<string, unknown> = {}) => ({
  model: plain,
  thinkingLevel: "off",
  levels: ["off"],
  preset: "configured",
  tools: ["read", "bash"],
  toolsTruncated: false,
  ...overrides,
});
const listed = { models: [plain, thinker], truncated: false, current: { provider: "faux", id: "plain" } };
const sent = (index = 0) => bed.spawned[index]?.requests.map((request) => request.type);

describe("sessions.models", () => {
  it("asks the live worker and answers its list", async () => {
    open({ replies: { get_available_models: { data: listed } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await bed.service.models(sessionId, OWNER)).toEqual(listed);
    expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "get_available_models" });
  });

  it("starts the worker of a cold session for its menu (M7R41)", async () => {
    open({ replies: { get_available_models: { data: listed } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(bed.service.list(OWNER)[0]?.status).toBe("cold");
    expect(await bed.service.models(sessionId, OWNER)).toEqual(listed);
    expect(bed.spawned).toHaveLength(2);
    expect(sent(1)).toEqual(["get_available_models"]);
  });

  it("is capacity-limited like any worker start", async () => {
    open({ limits: { maxWorkers: 1, minFreeMemMb: 0 }, replies: { get_available_models: { data: listed } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    const other = await bed.service.create(bed.otherWork, OWNER);
    expect(other.sessionId).not.toBe(sessionId);
    expect(await codeOf(bed.service.models(sessionId, OWNER))).toBe("capacity");
  });

  it("is not_found for another owner's session", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(await codeOf(bed.service.models(sessionId, testCaller({ userId: "someone-else" })))).toBe(
      "not_found",
    );
    expect(await codeOf(bed.service.models("ghost", OWNER))).toBe("not_found");
  });

  it("refuses an answer it cannot read (a worker bug) as command_failed, logging no worker text", async () => {
    const logs = captureLogger();
    open({
      logger: logs.logger,
      replies: { get_available_models: { data: { models: "<script>alert(1)</script>" } } },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const error = await bed.service.models(sessionId, OWNER).catch((caught: unknown) => caught);
    expect(error).toEqual(new PapError("command_failed"));
    expect((error as PapError).message).toBe(ERROR_MESSAGES.command_failed);
  });

  it("maps a refusal to command_failed without the worker's text", async () => {
    open({
      replies: { get_available_models: { success: false, error: "/home/u/.pi/agent/auth.json: EACCES" } },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const error = await bed.service.models(sessionId, OWNER).catch((caught: unknown) => caught);
    expect(error).toEqual(new PapError("command_failed"));
  });
});

describe("sessions.setModel", () => {
  it("sends the pick to the worker", async () => {
    open({ replies: { set_model: { data: {} } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    await bed.service.setModel({ sessionId, provider: "faux", modelId: "thinker" }, OWNER);
    expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({
      type: "set_model",
      provider: "faux",
      modelId: "thinker",
    });
  });

  it("is session_busy while a run goes on, and sends nothing (M7R43)", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.emit(0, { type: "agent_start" });
    await expect(
      bed.service.setModel({ sessionId, provider: "faux", modelId: "thinker" }, OWNER),
    ).rejects.toThrow(new PapError("session_busy"));
    expect(sent()).toEqual([]);
  });

  it("is session_busy while a prompt waits for its agent_start", async () => {
    open({ replies: { prompt: "held" } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    void bed.service.prompt({ sessionId, text: "go" }, OWNER).catch(() => undefined);
    await bed.clock.advance(0);
    expect(
      await codeOf(bed.service.setModel({ sessionId, provider: "faux", modelId: "thinker" }, OWNER)),
    ).toBe("session_busy");
  });

  it("maps the worker's busy marker to session_busy, and any other refusal to command_failed", async () => {
    open({ replies: { set_model: { success: false, error: "pap:session_busy" } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(
      await codeOf(bed.service.setModel({ sessionId, provider: "faux", modelId: "thinker" }, OWNER)),
    ).toBe("session_busy");
    bed.dispose();
    open({ replies: { set_model: { success: false, error: "No API key for faux/thinker" } } });
    const again = await bed.service.create(bed.work, OWNER);
    expect(
      await codeOf(
        bed.service.setModel({ sessionId: again.sessionId, provider: "faux", modelId: "thinker" }, OWNER),
      ),
    ).toBe("command_failed");
  });

  it("starts a cold session's worker", async () => {
    open({ replies: { set_model: { data: {} } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    await bed.service.setModel({ sessionId, provider: "faux", modelId: "thinker" }, OWNER);
    expect(sent(1)).toEqual(["set_model"]);
  });
});

describe("sessions.setThinking", () => {
  it("sends the level, even while a run goes on (M7R43)", async () => {
    open({ replies: { set_thinking_level: { data: {} } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.emit(0, { type: "agent_start" });
    await bed.service.setThinking({ sessionId, level: "high" }, OWNER);
    expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "set_thinking_level", level: "high" });
  });

  it("is not_found for another owner's session", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(
      await codeOf(bed.service.setThinking({ sessionId, level: "low" }, testCaller({ userId: "x" }))),
    ).toBe("not_found");
  });
});

describe("the loadout in the snapshot and on the stream (M7R44)", () => {
  it("is null for a session without a worker and for a live one that has not said it yet", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(((await bed.snapshot(sessionId)) as { loadout: unknown }).loadout).toBeNull();
  });

  it("carries the worker's loadout in the snapshot, and clears it when the worker is gone", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: loadout() });
    expect(((await bed.snapshot(sessionId)) as { loadout: { model: { id: string } } }).loadout.model.id).toBe(
      "plain",
    );
    bed.spawned[0]?.crash({ code: 1, signal: null, cause: "exit_code" });
    await bed.clock.advance(0);
    expect(((await bed.snapshot(sessionId)) as { loadout: unknown }).loadout).toBeNull();
  });

  it("publishes a loadout event once per change", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    const kinds = () => frames.map((frame) => (frame.event as { kind: string }).kind);
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: loadout() });
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: loadout() });
    bed.spawned[0]?.emitRaw({
      type: "loadout",
      loadout: loadout({ model: thinker, levels: ["off", "high"] }),
    });
    expect(kinds().filter((kind) => kind === "loadout")).toHaveLength(2);
    expect(frames.at(-1)?.event).toMatchObject({ kind: "loadout", loadout: { model: { id: "thinker" } } });
  });

  it("drops a loadout with 300 tools and warns once, naming nothing of the worker's text", async () => {
    const logs = captureLogger();
    open({ logger: logs.logger });
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    const frames = await bed.subscribe(sessionId);
    const hostile = loadout({ tools: Array.from({ length: 300 }, (_, i) => `<b>tool-${i}</b>`) });
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: hostile });
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: hostile });
    expect(frames.some((frame) => (frame.event as { kind: string }).kind === "loadout")).toBe(false);
    expect(((await bed.snapshot(sessionId)) as { loadout: unknown }).loadout).toBeNull();
    const warns = logs.lines.filter((line) => line.msg === "loadout_invalid");
    expect(warns).toHaveLength(1);
    expect(JSON.stringify(warns)).not.toContain("tool-");
  });

  it("keeps the last good loadout when a later one is invalid", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: loadout() });
    bed.spawned[0]?.emitRaw({ type: "loadout", loadout: loadout({ levels: "all" }) });
    expect(((await bed.snapshot(sessionId)) as { loadout: { model: { id: string } } }).loadout.model.id).toBe(
      "plain",
    );
  });
});
