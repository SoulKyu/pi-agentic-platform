import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBoxControl, createFakeBoxOps } from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createBoxStore } from "./box-store.ts";
import { createProjectsService } from "./service.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

const owner = testCaller();
let bed: ReturnType<typeof createProjectsBed>;

afterEach(() => bed.dispose());
beforeEach(() => {
  bed = createProjectsBed();
});

function world() {
  const enabled: string[] = [];
  const service = createProjectsService({
    isMember: () => false,
    store: createProjectsStore(bed.db),
    boxes: createBoxStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: () => "00000000-0000-4000-8000-000000000001",
    knowledge: {
      // A host root that must never be consulted for a box project.
      rootOfRow: () => null,
      rootFor: () => {
        throw new Error("host knowledge was read");
      },
      enabled: (_caller, projectId) => void enabled.push(projectId),
    },
  });
  const control = createFakeBoxControl();
  const ops = createFakeBoxOps({
    "knowledge.state": () => ({ enabled: true, concepts: 7 }),
    "knowledge.enable": () => ({ enabled: true as const }),
  });
  service.bindBoxes({
    control,
    ops,
    sessions: { count: () => 0, removeProject: async () => ({ sessions: 0 }) },
    automation: { count: () => 0, removeProject: async () => ({ triggers: 0 }) },
    requireStepUp: () => {},
  });
  const project = service.create(owner, "Notes");
  return { service, control, ops, enabled, id: project.id };
}
const code = async (run: Promise<unknown>) => ((await run.catch((e: unknown) => e)) as PapError).code;

describe("knowledge of a box project", () => {
  it("knowledge of a box project asks the guest", async () => {
    const { service, control, ops, enabled, id } = world();
    control.setPhase(id, "running");
    expect(await service.knowledge(owner, id)).toEqual({ enabled: true, concepts: 7 });
    expect(await service.enableKnowledge(owner, id)).toEqual({ enabled: true });
    expect(ops.calls.map((call) => call.op.name)).toEqual(["knowledge.state", "knowledge.enable"]);
    expect(enabled).toEqual([id]);
  });

  it("answers not_found for a project marked deleting", async () => {
    const { service, control, ops, id } = world();
    control.setPhase(id, "running");
    createBoxStore(bed.db).markDeleting(id);
    expect(await code(service.knowledge(owner, id))).toBe("not_found");
    expect(await code(service.enableKnowledge(owner, id))).toBe("not_found");
    expect(ops.calls).toEqual([]);
  });

  it("answers box_stopped for a stopped box, asks nothing and writes no audit row", async () => {
    const { service, control, ops, enabled, id } = world();
    expect(await code(service.knowledge(owner, id))).toBe("box_stopped");
    expect(await code(service.enableKnowledge(owner, id))).toBe("box_stopped");
    expect(ops.calls).toEqual([]);
    expect(control.calls).toEqual([]);
    expect(enabled).toEqual([]);
  });
});
