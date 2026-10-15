import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createSessionsLanePort, type LaneProbe } from "./lane-port.ts";
import type { LiveSession } from "./live-session.ts";
import type { SessionsService } from "./service-types.ts";
import type { SessionRow } from "./store.ts";

const caller = testCaller();
const rowOf = (id: string, ownerId: string, cwd: string) => ({ id, ownerId, cwd }) as SessionRow;
const rows = [
  rowOf("a", "u1", "/lanes/one"),
  rowOf("b", "u1", "/lanes/one/sub"),
  rowOf("c", "u1", "/lanes/two"),
  rowOf("d", "u1", "/lanes/one-more"),
  rowOf("e", "u2", "/lanes/one"),
];

type State = { status?: string; busy?: boolean; dialogs?: number; leaf?: string | null; stopping?: boolean };

function bed(states: Record<string, State> = {}, archived: string[] = [], waiting: string[] = []) {
  const live = new Map<string, LiveSession>();
  for (const [id, state] of Object.entries(states))
    live.set(id, {
      status: () => state.status ?? "idle",
      busy: () => state.busy ?? false,
      dialogs: () => Array.from({ length: state.dialogs ?? 0 }),
      leafId: () => state.leaf ?? null,
      stopping: () => state.stopping ?? false,
    } as unknown as LiveSession);
  const service = {
    create: vi.fn<SessionsService["create"]>(() => Promise.resolve({ sessionId: "new" })),
    setModel: vi.fn<SessionsService["setModel"]>(() => Promise.resolve()),
    setThinking: vi.fn<SessionsService["setThinking"]>(() => Promise.resolve()),
    prompt: vi.fn<SessionsService["prompt"]>(() => Promise.resolve({ disposition: "started" })),
    mark: vi.fn<SessionsService["mark"]>(),
    releaseIdle: vi.fn<SessionsService["releaseIdle"]>(() => "released"),
    reopen: vi.fn<SessionsService["reopen"]>(() => Promise.resolve()),
  };
  const probe: LaneProbe = {
    live,
    statusOf: (id) => (live.get(id)?.status() ?? (id === "reopening" ? "starting" : "cold")) as never,
    branchPath: vi.fn(() => Promise.resolve({ leafId: "l", entries: [] })),
    agentText: vi.fn(() => Promise.resolve("done")),
  };
  const { logger, lines } = captureLogger();
  const port = createSessionsLanePort({
    service,
    store: {
      listByOwner: (owner) => rows.filter((row) => row.ownerId === owner),
      get: (id) => rows.find((r) => r.id === id),
    },
    marks: { row: (id) => ({ marks: { archivedAt: archived.includes(id) ? 1 : null } }) as never },
    probe,
    waiting: (id) => waiting.includes(id),
    logger,
  });
  return { port, service, probe, lines };
}

describe("SessionsLanePort.create and prompt (M9R34)", () => {
  it("calls SessionsService.create with its existing arguments, then prompts through the service", async () => {
    const { port, service } = bed();
    expect(await port.create(caller, "/lanes/one", null)).toEqual({ sessionId: "new", modelRefused: false });
    expect(service.create).toHaveBeenCalledWith("/lanes/one", caller);
    expect(service.setModel).not.toHaveBeenCalled();
    await port.prompt(caller, "new", "go");
    expect(service.prompt).toHaveBeenCalledWith({ sessionId: "new", text: "go" }, caller);
  });

  it("sets the model then the thinking level when one is picked", async () => {
    const { port, service } = bed();
    const made = await port.create(caller, "/lanes/one", { provider: "p", modelId: "m", thinking: "high" });
    expect(made.modelRefused).toBe(false);
    expect(service.setModel).toHaveBeenCalledWith({ sessionId: "new", provider: "p", modelId: "m" }, caller);
    expect(service.setThinking).toHaveBeenCalledWith({ sessionId: "new", level: "high" }, caller);
  });

  it("keeps the default model and answers modelRefused when Pi refuses it; the session stays", async () => {
    const { port, service } = bed();
    service.setModel.mockRejectedValueOnce(new PapError("command_failed"));
    expect(
      await port.create(caller, "/lanes/one", { provider: "p", modelId: "m", thinking: "high" }),
    ).toEqual({
      sessionId: "new",
      modelRefused: true,
    });
    expect(service.setThinking).not.toHaveBeenCalled();
  });

  it("does not hide an error that is not a refusal", async () => {
    const { port, service } = bed();
    service.setModel.mockRejectedValueOnce(new Error("boom"));
    await expect(port.create(caller, "/lanes/one", { provider: "p", modelId: "m" })).rejects.toThrow("boom");
  });
});

describe("SessionsLanePort.activityIn", () => {
  it("counts the owner's sessions in the folder and below, not a sibling folder with the same prefix", () => {
    expect(bed().port.activityIn("u1", "/lanes/one")).toEqual({
      sessions: 2,
      busy: false,
      needsInput: false,
    });
  });

  it("is busy for a running or starting session, or one with a prompt pending, and needsInput for an open dialog", () => {
    expect(bed({ a: { status: "running" } }).port.activityIn("u1", "/lanes/one").busy).toBe(true);
    expect(bed({ a: { status: "starting" } }).port.activityIn("u1", "/lanes/one").busy).toBe(true);
    expect(bed({ b: { busy: true } }).port.activityIn("u1", "/lanes/one").busy).toBe(true);
    expect(bed({ a: { dialogs: 1 } }).port.activityIn("u1", "/lanes/one")).toEqual({
      sessions: 2,
      busy: false,
      needsInput: true,
    });
  });

  it("is busy while a prompt waits in the lane hooks", () => {
    expect(bed({ a: {} }, [], ["a"]).port.activityIn("u1", "/lanes/one").busy).toBe(true);
  });

  it("ignores another owner's busy session and an archived one", () => {
    expect(bed({ e: { status: "running", dialogs: 2 } }).port.activityIn("u1", "/lanes/one")).toEqual({
      sessions: 2,
      busy: false,
      needsInput: false,
    });
    expect(bed({ a: { status: "running" } }, ["a"]).port.activityIn("u1", "/lanes/one")).toEqual({
      sessions: 1,
      busy: false,
      needsInput: false,
    });
  });
});

describe("SessionsLanePort.runState", () => {
  it("answers the live leaf, idle only when the session is idle and not busy", () => {
    const { port } = bed({ a: { leaf: "leaf-9" }, b: { status: "running", leaf: "x" }, c: { busy: true } });
    expect(port.runState("u1", "a")).toEqual({ idle: true, leafId: "leaf-9" });
    expect(port.runState("u1", "b")).toEqual({ idle: false, leafId: "x" });
    expect(port.runState("u1", "c").idle).toBe(false);
  });

  it("is not idle while a prompt waits in the lane hooks", () => {
    expect(bed({ a: { leaf: "l" } }, [], ["a"]).port.runState("u1", "a")).toEqual({
      idle: false,
      leafId: "l",
    });
  });

  it("counts the caller's own waiting prompt as not pending when asked to (the capture it waits for)", () => {
    const { port } = bed({ a: { leaf: "l" }, b: { status: "running" } }, [], ["a", "b"]);
    expect(port.runState("u1", "a", { ownPrompt: true })).toEqual({ idle: true, leafId: "l" });
    expect(port.runState("u1", "b", { ownPrompt: true }).idle).toBe(false);
  });

  it("answers a cold session as idle with no leaf, and another owner's session as not idle", () => {
    const { port } = bed({ e: {} });
    expect(port.runState("u1", "d")).toEqual({ idle: true, leafId: null });
    expect(port.runState("u1", "e")).toEqual({ idle: false, leafId: null });
    expect(port.runState("u1", "missing")).toEqual({ idle: false, leafId: null });
  });
});

describe("SessionsLanePort.archiveIn", () => {
  it("archives every session of the owner in the folder and none outside, an archived one once", () => {
    const { port, service } = bed({}, ["b"]);
    expect(port.archiveIn(caller, "/lanes/one")).toBe(1);
    expect(service.mark.mock.calls).toEqual([[{ sessionId: "a", change: { kind: "archive" } }, caller]]);
  });

  it("logs a refused mark and goes on with the others", () => {
    const { port, service, lines } = bed();
    service.mark.mockImplementationOnce(() => {
      throw new PapError("limit_reached");
    });
    expect(port.archiveIn(caller, "/lanes/one")).toBe(1);
    expect(service.mark).toHaveBeenCalledTimes(2);
    expect(lines.filter((line) => line.msg === "lane_archive_session_refused")).toHaveLength(1);
  });
});

describe("SessionsLanePort.releaseIn (M9R113)", () => {
  it("calls releaseIdle for each live session of the owner in the folder, none of another owner's or outside", () => {
    const { port, service } = bed({ a: {}, b: {}, c: {}, e: {} });
    service.releaseIdle.mockImplementation((...args) => (args[1] === "a" ? "released" : "busy"));
    expect(port.releaseIn("u1", "/lanes/one")).toEqual({ released: 1, busy: 1 });
    expect(service.releaseIdle.mock.calls).toEqual([
      ["u1", "a"],
      ["u1", "b"],
    ]);
  });
});

describe("SessionsLanePort.sessionIdsIn (M9R119)", () => {
  it("lists the owner's sessions in the folder, the archived ones too: their edits and taint stay", () => {
    const { port } = bed({}, ["b"]);
    expect(port.sessionIdsIn("u1", "/lanes/one")).toEqual(["a", "b"]);
  });
});

describe("SessionsLanePort reads", () => {
  it("branchPath goes through the probe for the caller, lastAgentText through it by session", async () => {
    const { port, probe } = bed();
    expect(await port.branchPath(caller, "a")).toEqual({ leafId: "l", entries: [] });
    expect(probe.branchPath).toHaveBeenCalledWith(caller, "a");
    expect(await port.lastAgentText("a", 500)).toBe("done");
    expect(probe.agentText).toHaveBeenCalledWith("a", 500);
  });
});
