import type { EventFrame, HandlerContext, ShellStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeBoxControl, createFakeBoxOps } from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createProjectsModule } from "../projects/index.ts";
import { createProjectsBed } from "../projects/testing/bed.ts";
import { createSessionsService } from "./service.ts";
import { createSessionsStore } from "./store.ts";
import { type BedOptions, createServiceBed } from "./testing/service-bed.ts";
import { loadTranscriptReader } from "./transcript.ts";

const build = (options?: BedOptions) =>
  createServiceBed({ createSessionsStore, createSessionsService, loadTranscriptReader }, options);
let bed: ReturnType<typeof build>;
let projectsBed: ReturnType<typeof createProjectsBed>;
afterEach(() => {
  bed.dispose();
  projectsBed.dispose();
});

const caller = testCaller();
const ctx: HandlerContext = {
  caller,
  connectionId: "c1",
  openSubscription: vi.fn(() => "s1"),
  closeSubscription: vi.fn(),
};

/** The real projects module under the real sessions service: what the shell stream carries of a box project. */
function world() {
  projectsBed = createProjectsBed();
  let counter = 0;
  const projects = createProjectsModule({
    db: projectsBed.db,
    clock: projectsBed.clock,
    logger: projectsBed.logger,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  });
  const control = createFakeBoxControl();
  projects.bindBoxes({
    control,
    ops: createFakeBoxOps(),
    sessions: { count: () => 0, removeProject: async () => ({ sessions: 0 }) },
    automation: { count: () => 0, removeProject: async () => ({ triggers: 0 }) },
    requireStepUp: () => {},
  });
  bed = build({ projects: projects.port });
  return { projects, control };
}

describe("the shell stream and box projects (R3)", () => {
  it("carries the box phase of a box project, and nothing for a host project", async () => {
    const { projects } = world();
    const { project } = await projects.rpc["projects.create"]({ name: "Notes" }, ctx);
    projects.port.ensure("u1", "/w/host");
    const snapshot = bed.service.shellSnapshot("u1");
    if (snapshot.kind !== "snapshot") throw new Error("not a snapshot");
    const byId = new Map(snapshot.projects.map((one) => [one.id, one]));
    expect(byId.get(project.id)).toMatchObject({ kind: "box", box: { phase: "stopped" } });
    const host = [...byId.values()].find((one) => one.root === "/w/host");
    expect(host).toBeDefined();
    expect(host).not.toHaveProperty("box");
  });

  it("republishes the project when the box changes phase", async () => {
    const { projects, control } = world();
    const { project } = await projects.rpc["projects.create"]({ name: "Notes" }, ctx);
    bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c-shell",
      sub: "s-shell",
      stream: "shell",
      key: "u1",
      after: undefined,
      send: (frame) => void frames.push(frame),
    });
    frames.length = 0;
    control.setPhase(project.id, "running");
    await bed.clock.advance(0);
    const events = frames.map((frame) => frame.event as ShellStreamEvent);
    expect(events).toEqual([
      expect.objectContaining({
        kind: "project",
        project: expect.objectContaining({ id: project.id, box: { phase: "running" } }),
      }),
    ]);
  });

  it("publishes projectRemoved to the owner when the box project is deleted", async () => {
    const { projects } = world();
    const { project } = await projects.rpc["projects.create"]({ name: "Notes" }, ctx);
    bed.hub.registerSnapshot("shell", (key) => bed.service.shellSnapshot(key));
    const frames: EventFrame[] = [];
    bed.hub.open({
      connectionId: "c-shell",
      sub: "s-shell",
      stream: "shell",
      key: "u1",
      after: undefined,
      send: (frame) => void frames.push(frame),
    });
    frames.length = 0;
    await projects.rpc["projects.delete"](
      { projectId: project.id },
      {
        ...ctx,
        caller: testCaller({ stepUpUntil: Number.MAX_SAFE_INTEGER }),
      },
    );
    await bed.clock.advance(0);
    const events = frames.map((frame) => frame.event as ShellStreamEvent);
    expect(events).toContainEqual({ kind: "projectRemoved", projectId: project.id });
  });
});
