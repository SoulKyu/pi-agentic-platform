import { type Caller, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeBoxControl, createFakeBoxOps } from "../../kernel/testing/fake-boxes.ts";
import { testCaller } from "../../testing/caller.ts";
import { createBoxStore } from "./box-store.ts";
import { createProjectsService } from "./service.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

const owner = testCaller();
const member: Caller = testCaller({ userId: "u2" });
let bed: ReturnType<typeof createProjectsBed>;
let service: ReturnType<typeof createProjectsService>;
let changes: Array<{ ownerId: string; projectId: string; alwaysOn: boolean }>;
let id: string;

beforeEach(() => {
  bed = createProjectsBed();
  let counter = 0;
  service = createProjectsService({
    isMember: () => false,
    store: createProjectsStore(bed.db),
    boxes: createBoxStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
  });
  service.bindBoxes({
    control: createFakeBoxControl(),
    ops: createFakeBoxOps(),
    sessions: { count: () => 0, removeProject: async () => ({ sessions: 0 }) },
    automation: { count: () => 0, removeProject: async () => ({ triggers: 0 }) },
    requireStepUp: () => undefined,
  });
  changes = [];
  service.onAlwaysOnChange((change) => changes.push(change));
  id = service.create(owner, "Notes").id;
});
afterEach(() => bed.dispose());

describe("setBox alwaysOn", () => {
  it("stores the value and a new read still says so", () => {
    expect(service.box(owner, id).alwaysOn).toBe(false);
    expect(service.setBox(owner, { projectId: id, alwaysOn: true }).alwaysOn).toBe(true);
    expect(service.box(owner, id).alwaysOn).toBe(true);
  });

  it("tells the listener once, and not for the same value again", () => {
    service.setBox(owner, { projectId: id, alwaysOn: true });
    service.setBox(owner, { projectId: id, alwaysOn: true });
    expect(changes).toEqual([{ ownerId: "u1", projectId: id, alwaysOn: true }]);
    service.setBox(owner, { projectId: id, alwaysOn: false });
    expect(changes).toHaveLength(2);
  });

  it("keeps the stored value when a setBox leaves it out", () => {
    service.setBox(owner, { projectId: id, alwaysOn: true });
    service.setBox(owner, { projectId: id, hosts: ["example.test"] });
    expect(service.box(owner, id).alwaysOn).toBe(true);
    expect(changes).toHaveLength(1);
  });

  it("logs a throwing listener and still answers", () => {
    service.onAlwaysOnChange(() => {
      throw new Error("boom");
    });
    expect(service.setBox(owner, { projectId: id, alwaysOn: true }).alwaysOn).toBe(true);
    expect(bed.lines.some((line) => line.msg === "projects_listener_failed")).toBe(true);
  });

  it("answers not_found to a member on the owner's project", () => {
    let code: string | undefined;
    try {
      service.setBox(member, { projectId: id, alwaysOn: true });
    } catch (error) {
      code = error instanceof PapError ? error.code : "other";
    }
    expect(code).toBe("not_found");
    expect(changes).toEqual([]);
  });
});
