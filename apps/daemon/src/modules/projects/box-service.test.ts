import { DEFAULT_PROJECT_RESOURCES, PapError, type Caller } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFakeBoxControl,
  createFakeBoxOps,
  type FakeBoxControl,
} from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createProjectBoxSource } from "./box-source.ts";
import { createBoxStore } from "./box-store.ts";
import { type ProjectBoxWiring, createProjectsService } from "./service.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const owner = testCaller();
const confirmed = (): Caller => testCaller({ stepUpUntil: Number.MAX_SAFE_INTEGER });
let bed: ReturnType<typeof createProjectsBed>;
let service: ReturnType<typeof createProjectsService>;
let control: FakeBoxControl;
let steps: string[];
let sessionCount: number;
let triggerCount: number;
let host: { memoryCapMb: number; cores: number };
let changes: Array<{ ownerId: string; phase: string | undefined }>;
let wiring: ProjectBoxWiring;

beforeEach(() => {
  bed = createProjectsBed();
  let counter = 0;
  const boxes = createBoxStore(bed.db);
  service = createProjectsService({
    store: createProjectsStore(bed.db),
    boxes,
    clock: bed.clock,
    logger: bed.logger,
    newId: () => ID(++counter),
  });
  control = createFakeBoxControl();
  steps = [];
  sessionCount = 0;
  triggerCount = 0;
  host = { memoryCapMb: 16_384, cores: 4 };
  wiring = {
    control: {
      ...control,
      dispose: async (projectId, stamp) => {
        steps.push(`dispose deleting=${String(boxes.get(projectId)?.deleting)}`);
        await control.dispose(projectId, stamp);
      },
    },
    ops: createFakeBoxOps(),
    sessions: {
      count: () => sessionCount,
      removeProject: async () => {
        steps.push("sessions");
        return { sessions: sessionCount };
      },
    },
    automation: {
      count: () => triggerCount,
      removeProject: async () => {
        steps.push("triggers");
        return { triggers: triggerCount };
      },
    },
    requireStepUp: (caller, now) => {
      if (caller.stepUpUntil <= now) throw new PapError("step_up_required");
    },
    resourceHost: () => host,
  };
  service.bindBoxes(wiring);
  changes = [];
  service.onChange((ownerId, project) => changes.push({ ownerId, phase: project.box?.phase }));
});
afterEach(() => bed.dispose());

const codeOf = async (run: () => unknown): Promise<string | undefined> => {
  try {
    await run();
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
  return undefined;
};

describe("box projects", () => {
  it("creates a box project rooted where the box says", () => {
    const { id, ...view } = service.create(owner, "  Notes ");
    expect(view).toMatchObject({
      kind: "box",
      name: "Notes",
      root: control.rootOf(id),
      box: { phase: "stopped" },
    });
    expect(service.box(owner, id)).toMatchObject({
      resources: DEFAULT_PROJECT_RESOURCES,
      hosts: [],
      scratch: false,
      counts: { sessions: 0, triggers: 0 },
    });
    expect(changes).toEqual([{ ownerId: "u1", phase: "stopped" }]);
  });

  it("answers internal until the composition gives the box control", () => {
    const bare = createProjectsService({
      store: createProjectsStore(bed.db),
      boxes: createBoxStore(bed.db),
      clock: bed.clock,
      logger: bed.logger,
      newId: bed.newId,
    });
    expect(() => bare.create(owner, "x")).toThrow(expect.objectContaining({ code: "internal" }));
  });

  it("one Scratch per owner", () => {
    const first = service.scratch(owner);
    expect(first).toMatchObject({ name: "Scratch", scratch: true, kind: "box" });
    expect(service.scratch(owner).id).toBe(first.id);
    const other = service.scratch(testCaller({ userId: "u2" }));
    expect(other.id).not.toBe(first.id);
    expect(service.box(owner, first.id).scratch).toBe(true);
  });

  it("tells the shell stream when the box changes phase", () => {
    const { id } = service.create(owner, "Notes");
    changes.length = 0;
    control.setPhase(id, "running");
    expect(changes).toEqual([{ ownerId: "u1", phase: "running" }]);
  });

  it("starts, restarts and rebuilds only the owner's box projects", async () => {
    const { id } = service.create(owner, "Notes");
    await service.startBox(owner, id);
    await service.restartBox(owner, id);
    await service.rebuild(owner, id);
    expect(control.calls).toEqual([
      ["start", id],
      ["restart", id],
      ["rebuild", id],
    ]);
    expect(await codeOf(() => service.startBox(testCaller({ userId: "u2" }), id))).toBe("not_found");
    expect(await codeOf(() => service.startBox(owner, "nope"))).toBe("not_found");
  });

  it("answers command_failed when the image build fails, and nothing changes", async () => {
    const { id } = service.create(owner, "Notes");
    service.bindBoxes({
      ...wiring,
      control: {
        ...wiring.control,
        rebuild: async () => {
          throw new Error("podman build exploded");
        },
      },
    });
    expect(await codeOf(() => service.rebuild(owner, id))).toBe("command_failed");
    expect(service.box(owner, id).phase).toBe("stopped");
  });

  it("refuses to start, restart, rebuild or change a box being deleted", async () => {
    const { id } = service.create(owner, "Notes");
    createBoxStore(bed.db).markDeleting(id);
    for (const run of [
      () => service.startBox(owner, id),
      () => service.restartBox(owner, id),
      () => service.rebuild(owner, id),
      () => service.setBox(owner, { projectId: id, hosts: ["example.test"] }),
    ])
      expect(await codeOf(run)).toBe("not_found");
    expect(control.calls).toEqual([]);
    expect(service.box(owner, id).hosts).toEqual([]);
  });

  it("delete stops the box, removes sessions and triggers, then the rows", async () => {
    const { id } = service.create(owner, "Notes");
    sessionCount = 2;
    triggerCount = 1;
    expect(service.box(owner, id).counts).toEqual({ sessions: 2, triggers: 1 });
    expect(await codeOf(() => service.remove(owner, id))).toBe("step_up_required");
    expect(steps).toEqual([]);
    await service.remove(confirmed(), id);
    expect(steps).toEqual(["triggers", "sessions", "dispose deleting=true"]);
    expect(control.calls).toEqual([["dispose", id, bed.clock.now()]]);
    expect(service.all("u1")).toEqual([]);
    expect(createProjectBoxSource(createBoxStore(bed.db)).box(id)).toBeNull();
  });

  it("delete tells the removal listeners once, after the rows are gone and not when it is refused", async () => {
    const removed: Array<[string, string, number]> = [];
    service.onRemoved((ownerId, projectId) =>
      removed.push([ownerId, projectId, service.all(ownerId).length]),
    );
    const { id } = service.create(owner, "Notes");
    expect(await codeOf(() => service.remove(owner, id))).toBe("step_up_required");
    expect(removed).toEqual([]);
    await service.remove(confirmed(), id);
    expect(removed).toEqual([["u1", id, 0]]);
  });

  it("delete of Scratch with sessions is a conflict", async () => {
    const { id } = service.scratch(owner);
    sessionCount = 1;
    expect(await codeOf(() => service.remove(confirmed(), id))).toBe("conflict");
    expect(steps).toEqual([]);
    sessionCount = 0;
    await service.remove(confirmed(), id);
    expect(service.all("u1")).toEqual([]);
  });

  it("delete refuses a host project", async () => {
    const host = service.ensure("u1", "/w/api");
    expect(await codeOf(() => service.remove(confirmed(), host?.id ?? ""))).toBe("not_found");
  });

  it("setBox refuses a smaller disk", () => {
    const { id } = service.create(owner, "Notes");
    const resources = { ...DEFAULT_PROJECT_RESOURCES, diskMb: DEFAULT_PROJECT_RESOURCES.diskMb - 1024 };
    expect(() => service.setBox(owner, { projectId: id, resources })).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    const bigger = { ...DEFAULT_PROJECT_RESOURCES, diskMb: DEFAULT_PROJECT_RESOURCES.diskMb + 1024 };
    expect(
      service.setBox(owner, { projectId: id, resources: bigger, hosts: ["example.test"] }),
    ).toMatchObject({
      resources: bigger,
      hosts: ["example.test"],
    });
  });

  it("setBox refuses resources over the host's ceilings", () => {
    const { id } = service.create(owner, "Notes");
    host = { memoryCapMb: 2048, cores: 1 };
    const resources = { ...DEFAULT_PROJECT_RESOURCES, cpus: 2 };
    expect(() => service.setBox(owner, { projectId: id, resources })).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
  });

  it("create refuses a host too small for the default box", () => {
    host = { memoryCapMb: 1024, cores: 1 };
    expect(() => service.create(owner, "Notes")).toThrow(expect.objectContaining({ code: "bad_request" }));
    expect(service.all("u1")).toEqual([]);
  });
});
