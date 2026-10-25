import { DEFAULT_PROJECT_RESOURCES } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { composeBoxes, createBoxCrashPause } from "./compose-boxes.ts";
import type { ProjectBoxRow } from "./kernel/boxes.ts";
import { silentLogger } from "./kernel/logger.ts";
import { createFakeProjectBoxSource } from "./kernel/testing/fake-boxes.ts";
import { layoutOf, projectLayoutOf } from "./modules/agent-vm/index.ts";
import type { SessionRow } from "./modules/sessions/index.ts";
import { captureLogger } from "./testing/capture-logger.ts";

const HOME = "/pap";
const ID = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
const OTHER = "0a1b2c3d-1111-4222-8333-444455556666";
const ROOT = `${HOME}/tmp/boxes/${ID}`;
const box = (extra: Partial<ProjectBoxRow> = {}): ProjectBoxRow => ({
  ownerId: "u1",
  // The box's root is its project folder (lane B): the box folder above it is no project path.
  root: `${ROOT}/project`,
  resources: DEFAULT_PROJECT_RESOURCES,
  hosts: [],
  deleting: false,
  ...extra,
});
const row = (extra: Partial<SessionRow> = {}): SessionRow =>
  ({ id: "s1", ownerId: "u1", cwd: `${ROOT}/project`, piPath: null, ...extra }) as SessionRow;

function bound(
  rows: Record<string, ProjectBoxRow> = { [ID]: box() },
  nameOf: () => string | null = () => null,
) {
  const boxes = composeBoxes(HOME, silentLogger, null);
  boxes.bind({ source: createFakeProjectBoxSource(rows), nameOf });
  return boxes;
}

describe("the box rows of the sessions module", () => {
  it("finds the project of a row with no agent whose cwd is in the box, lexically", () => {
    const { sessions } = bound();
    expect(sessions.projectOf(row())).toBe(ID);
    expect(sessions.projectOf(row({ cwd: `${ROOT}/project/src/deep` }))).toBe(ID);
  });
  it("finds none for look-alikes, another owner's row, an agent's row or a host folder", () => {
    const { sessions } = bound();
    for (const cwd of [
      `${ROOT}/projectX`,
      `${ROOT}/project/../x`,
      `${ROOT}/../${OTHER}/project`,
      ROOT,
      "/home/u/work",
    ])
      expect(sessions.projectOf(row({ cwd }))).toBeNull();
    expect(sessions.projectOf(row({ ownerId: "u2" }))).toBeNull();
    expect(sessions.projectOf(row({ agentId: "atlas-1a2b", agentRole: "thread" }))).toBeNull();
  });
  it("finds none before the late binding: no row is in a box and no box has a layout", () => {
    const boxes = composeBoxes(HOME, silentLogger, null);
    expect(boxes.sessions.projectOf(row())).toBeNull();
    expect(boxes.sessions.box(ID)).toBeNull();
    expect(boxes.vmLayoutOf(row())).toBeNull();
  });
});

describe("the layouts", () => {
  it("gives a project row its box's layout, an agent row its own, and a host row none", () => {
    const boxes = bound();
    expect(boxes.vmLayoutOf(row())).toEqual(projectLayoutOf("process", HOME, ID));
    expect(boxes.vmLayoutOf(row({ agentId: "atlas-1a2b", agentRole: "thread" }))).toEqual(
      layoutOf("process", HOME, { agentId: "atlas-1a2b", taskKey: null }),
    );
    expect(boxes.vmLayoutOf(row({ cwd: "/home/u/work" }))).toBeNull();
  });
  it("keeps a layout for a project being deleted (the gate refuses it), none for one the source lost", () => {
    expect(bound({ [ID]: box({ deleting: true }) }).vmLayoutOf(row())).not.toBeNull();
    expect(bound({}).vmLayoutOf(row())).toBeNull();
  });
  it("answers the runtime a project box's layout by its spec", () => {
    const boxes = bound();
    expect(boxes.layoutOfSpec({ box: { kind: "project", id: ID }, taskKey: null })).toEqual(
      projectLayoutOf("process", HOME, ID),
    );
    expect(boxes.layoutOfSpec({ box: { kind: "agent", id: "atlas-1a2b" }, taskKey: null })).toEqual(
      layoutOf("process", HOME, { agentId: "atlas-1a2b", taskKey: null }),
    );
  });
});

describe("the recheck before a box starts", () => {
  it("passes a live project of the owner, and refuses a gone, deleting or another owner's one", () => {
    const { recheckProject } = bound().launchDeps;
    expect(() => recheckProject("u1", ID)).not.toThrow();
    expect(() => recheckProject("u2", ID)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => recheckProject("u1", OTHER)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => bound({ [ID]: box({ deleting: true }) }).launchDeps.recheckProject("u1", ID)).toThrow(
      expect.objectContaining({ code: "not_found" }),
    );
  });
  it("answers the test image tag on a backend with no Kata images, or the seam's", async () => {
    expect(await bound().launchDeps.projectImageTagOf(ID)).toMatch(/^pap-agent-agent-0{64}$/);
    const seamed = composeBoxes(HOME, silentLogger, null, () => `pap-agent-agent-${"1".repeat(64)}`);
    expect(await seamed.launchDeps.projectImageTagOf(ID)).toMatch(/^pap-agent-agent-1{64}$/);
  });
  it("asks Kata's images to resolve the project's profile image", async () => {
    const resolve = vi.fn(async () => `pap-agent-agent-${"2".repeat(64)}`);
    const boxes = composeBoxes(HOME, silentLogger, { resolve, forget: () => {} });
    expect(await boxes.launchDeps.projectImageTagOf(ID)).toMatch(/^pap-agent-agent-2{64}$/);
    expect(resolve).toHaveBeenCalledWith(ID, [], "thread", undefined);
    expect(boxes.layoutOfSpec({ box: { kind: "project", id: ID }, taskKey: null }).root).toBe(`/boxes/${ID}`);
  });
});

describe("the crash pause of a box", () => {
  it("routes an agent to the agents' pause and a project to the box's, which is logged until bound", () => {
    const captured = captureLogger();
    const boxes = composeBoxes(HOME, captured.logger, null);
    const agent = vi.fn();
    boxes.crashPause({ kind: "agent", id: "atlas-1a2b" }, agent);
    expect(agent).toHaveBeenCalledWith("atlas-1a2b");
    boxes.crashPause({ kind: "project", id: ID }, agent);
    expect(agent).toHaveBeenCalledTimes(1);
    expect(captured.lines.map((line) => line.msg)).toEqual(["box_vm_crash_pause_unwired"]);
    const handler = vi.fn();
    boxes.bindCrashPause(handler);
    boxes.crashPause({ kind: "project", id: ID }, agent);
    expect(handler).toHaveBeenCalledWith(ID);
  });

  it("posts one box_paused item carrying the project's name and no agent, for its owner, and nothing for an unknown project", () => {
    const upsertAgentItem = vi.fn(() => true);
    const captured = captureLogger();
    const boxes = bound({ [ID]: box() }, () => "Api");
    const pause = createBoxCrashPause({ boxes, items: { upsertAgentItem }, logger: captured.logger });
    pause(ID);
    expect(upsertAgentItem).toHaveBeenCalledTimes(1);
    expect(upsertAgentItem).toHaveBeenCalledWith({
      ownerId: "u1",
      kind: "box_paused",
      agentId: null,
      title: "Api",
      refId: ID,
      detail: "La box s'est arrêtée trois fois en dix minutes ; elle est en pause.",
      toHandle: false,
    });
    pause(OTHER);
    expect(upsertAgentItem).toHaveBeenCalledTimes(1);
    expect(captured.lines.map((line) => line.msg)).toEqual(["box_vm_crash_pause_unknown_project"]);
  });

  it("falls back to the project id when the name lookup finds none", () => {
    const upsertAgentItem = vi.fn(() => true);
    createBoxCrashPause({ boxes: bound(), items: { upsertAgentItem }, logger: silentLogger })(ID);
    expect(upsertAgentItem).toHaveBeenCalledWith(expect.objectContaining({ title: ID }));
  });
});
