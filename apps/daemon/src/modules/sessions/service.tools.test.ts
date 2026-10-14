import { type DaemonToWorker, type InitRecord, PapError, type PolicyRules } from "@pap/contracts";
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

const initOf = (index: number): InitRecord => {
  const init = bed.spawned[index]?.sent.find((record) => record.type === "init");
  if (!init || init.type !== "init") throw new Error(`worker ${index} got no init`);
  return init;
};
const rulesOf = (init: InitRecord) => init.policy as PolicyRules;
const updates = (index: number) =>
  (bed.spawned[index]?.sent ?? []).filter(
    (record): record is Extract<DaemonToWorker, { type: "policy_update" }> => record.type === "policy_update",
  );
const sent = (index: number) => bed.spawned[index]?.requests.map((request) => request.type);
const presetInDb = (id: string) =>
  bed.db.get<{ tool_preset: string | null }>("SELECT tool_preset FROM sessions WHERE id = $id", { id })
    ?.tool_preset;
const crash = async (index: number) => {
  bed.spawned[index]?.crash({ code: 1, signal: null, cause: "exit_code" });
  await bed.clock.advance(0);
};

describe("sessions.create with a preset (M7R76)", () => {
  it("stores the preset and starts the worker with it", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "chat");
    expect(presetInDb(sessionId)).toBe("chat");
    expect(initOf(0).tools).toEqual({ preset: "chat" });
  });

  it("follows Pi's default tools without a preset: NULL in the row, configured in the init", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(presetInDb(sessionId)).toBeNull();
    expect(initOf(0).tools).toEqual({ preset: "configured" });
    expect(rulesOf(initOf(0)).readOnlyPreset).toBe(false);
  });

  it("stores configured as NULL", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "configured");
    expect(presetInDb(sessionId)).toBeNull();
  });

  it("composes readOnlyPreset into the rules of a read-only session, and of no other", async () => {
    open();
    await bed.service.create(bed.work, OWNER, "read-only");
    await bed.service.create(bed.work, OWNER, "full");
    expect(rulesOf(initOf(0)).readOnlyPreset).toBe(true);
    expect(rulesOf(initOf(1)).readOnlyPreset).toBe(false);
  });

  it("starts a reopened worker with the stored preset", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "read-only");
    await crash(0);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(initOf(1).tools).toEqual({ preset: "read-only" });
    expect(rulesOf(initOf(1)).readOnlyPreset).toBe(true);
  });
});

describe("sessions.setTools", () => {
  it("applies a change between non-chat presets in place, stores it and pushes the rules", async () => {
    open({ replies: { set_tools: { data: {} } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    expect(bed.spawned[0]?.requests.at(-1)).toMatchObject({ type: "set_tools", preset: "read-only" });
    expect(presetInDb(sessionId)).toBe("read-only");
    expect(bed.spawned).toHaveLength(1);
    expect(updates(0).at(-1)?.rules).toMatchObject({ readOnlyPreset: true });
    await bed.service.setTools({ sessionId, preset: "configured" }, OWNER);
    expect(presetInDb(sessionId)).toBeNull();
    expect(updates(0).at(-1)?.rules).toMatchObject({ readOnlyPreset: false });
  });

  it("is session_busy while a run goes on, sends nothing and stores nothing", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    bed.emit(0, { type: "agent_start" });
    expect(await codeOf(bed.service.setTools({ sessionId, preset: "read-only" }, OWNER))).toBe(
      "session_busy",
    );
    expect(sent(0)).toEqual([]);
    expect(presetInDb(sessionId)).toBe("full");
  });

  it("maps the worker's busy marker to session_busy and keeps the stored preset", async () => {
    open({ replies: { set_tools: { success: false, error: "pap:session_busy" } } });
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    expect(await codeOf(bed.service.setTools({ sessionId, preset: "none" }, OWNER))).toBe("session_busy");
    expect(presetInDb(sessionId)).toBe("full");
  });

  it("maps any other refusal to command_failed without the worker's text, and stores nothing", async () => {
    const logs = captureLogger();
    open({
      logger: logs.logger,
      replies: { set_tools: { success: false, error: "/home/u/secret exploded" } },
    });
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    const error = await bed.service.setTools({ sessionId, preset: "none" }, OWNER).catch((e: unknown) => e);
    expect(error).toEqual(new PapError("command_failed"));
    expect(presetInDb(sessionId)).toBe("full");
  });

  it("releases the worker when the change crosses into chat, and the next prompt starts one with chat", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    await bed.service.setTools({ sessionId, preset: "chat" }, OWNER);
    expect(presetInDb(sessionId)).toBe("chat");
    expect(bed.spawned[0]?.stopped()).toBe(true);
    expect(sent(0)).toEqual([]);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(bed.spawned).toHaveLength(2);
    expect(initOf(1).tools).toEqual({ preset: "chat" });
  });

  it("releases the worker when the change leaves chat", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "chat");
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    expect(bed.spawned[0]?.stopped()).toBe(true);
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(initOf(1).tools).toEqual({ preset: "read-only" });
    expect(rulesOf(initOf(1)).readOnlyPreset).toBe(true);
  });

  it("does not release a busy worker to cross the chat boundary", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    bed.emit(0, { type: "agent_start" });
    expect(await codeOf(bed.service.setTools({ sessionId, preset: "chat" }, OWNER))).toBe("session_busy");
    expect(bed.spawned[0]?.stopped()).toBe(false);
    expect(presetInDb(sessionId)).toBe("full");
  });

  it("only stores the preset of a cold session, without starting a worker", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, "full");
    await crash(0);
    await bed.service.setTools({ sessionId, preset: "read-only" }, OWNER);
    expect(bed.spawned).toHaveLength(1);
    expect(presetInDb(sessionId)).toBe("read-only");
    await bed.service.prompt({ sessionId, text: "go" }, OWNER);
    expect(initOf(1).tools).toEqual({ preset: "read-only" });
  });

  it("is not_found for another owner's session and for a ghost", async () => {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER);
    expect(
      await codeOf(bed.service.setTools({ sessionId, preset: "none" }, testCaller({ userId: "x" }))),
    ).toBe("not_found");
    expect(await codeOf(bed.service.setTools({ sessionId: "ghost", preset: "none" }, OWNER))).toBe(
      "not_found",
    );
    expect(presetInDb(sessionId)).toBeNull();
  });
});

describe("a fork or clone takes its source's preset", () => {
  const TWO: ReadonlyArray<readonly [string, string]> = [
    ["q0", "r0"],
    ["q1", "r1"],
  ];
  async function bound(preset: "read-only" | "chat") {
    open();
    const { sessionId } = await bed.service.create(bed.work, OWNER, preset);
    bed.store.bindPiFile(sessionId, bed.writePiFile(0, TWO), "pi-0");
    return sessionId;
  }

  it("never starts a clone looser than the session it came from", async () => {
    const sessionId = await bound("read-only");
    const clone = await bed.service.clone({ sessionId }, OWNER);
    expect(presetInDb(clone.sessionId)).toBe("read-only");
  });

  it("never starts a fork looser than the session it came from", async () => {
    const sessionId = await bound("chat");
    const forked = await bed.service.fork({ sessionId, entryId: "u1" }, OWNER);
    expect(presetInDb(forked.sessionId)).toBe("chat");
  });
});
