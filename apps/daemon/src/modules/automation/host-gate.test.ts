import { afterEach, describe, expect, it } from "vitest";
import { createFakeProjectBoxSource } from "../../kernel/testing/fake-boxes.ts";
import { createAutomationBed, manualInput, type AutomationBed } from "./testing/bed.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

const ROOT = "/boxes/p1/project";
const boxes = () =>
  createFakeProjectBoxSource({
    p1: {
      ownerId: "m1",
      root: ROOT,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      deleting: false,
    },
  });

describe("a member's trigger (M14)", () => {
  it("on a host folder is forbidden before the folder is resolved, and no project is made", () => {
    bed = createAutomationBed({ boxes, isMember: (id) => id === "m1" });
    const member = bed.owner({ userId: "m1" });
    // A folder that does not exist: a host check would say invalid_cwd, so `forbidden` shows the host was not asked.
    expect(() => bed.triggers.create(member, manualInput("/does/not/exist"))).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => bed.triggers.create(member, manualInput(bed.folder))).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM triggers")?.n).toBe(0);
    expect(bed.db.get<{ n: number }>("SELECT count(*) AS n FROM projects")?.n).toBe(0);
  });

  it("in their box is kept, and the owner keeps the host folder", () => {
    bed = createAutomationBed({ boxes, isMember: (id) => id === "m1" });
    const { trigger } = bed.triggers.create(bed.owner({ userId: "m1" }), manualInput(`${ROOT}/src`));
    expect(trigger).toMatchObject({ cwd: `${ROOT}/src`, projectId: "p1" });
    expect(bed.triggers.create(bed.owner(), manualInput(bed.folder)).trigger.cwd).toBe(bed.folder);
  });
});
