import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createBoxStore } from "./box-store.ts";
import { createProjectsService } from "./service.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

let bed: ReturnType<typeof createProjectsBed>;
let service: ReturnType<typeof createProjectsService>;
let resolved: string[];
beforeEach(() => {
  bed = createProjectsBed();
  resolved = [];
  service = createProjectsService({
    isMember: (id) => id === "m1",
    boxes: createBoxStore(bed.db),
    store: createProjectsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: bed.newId,
    folders: {
      resolve: (root) => {
        resolved.push(root);
        return root;
      },
      scopeOf: (real) => real,
      stateDirs: [],
    },
  });
});
afterEach(() => bed.dispose());

const rows = () => bed.db.get<{ n: number }>("SELECT count(*) AS n FROM projects")?.n;

describe("host projects for a member (M14)", () => {
  it("ensure never inserts a host project for a member", () => {
    expect(() => service.ensure("m1", "/w/api")).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(rows()).toBe(0);
  });

  it("add refuses a member before the folder is resolved on the host", () => {
    const member = testCaller({ userId: "m1" });
    expect(() => service.add(member, "/w/api")).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(resolved).toEqual([]);
    expect(rows()).toBe(0);
  });

  it("the owner keeps their host projects", () => {
    expect(service.ensure("u1", "/w/api")?.kind).not.toBe("box");
    expect(service.add(testCaller(), "/w/web").root).toBe("/w/web");
    expect(resolved).toEqual(["/w/web"]);
  });
});
