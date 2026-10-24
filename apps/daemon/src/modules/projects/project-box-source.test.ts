import { AGENT_LIMITS } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProjectBoxSource } from "./box-source.ts";
import { createBoxStore } from "./box-store.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
let bed: ReturnType<typeof createProjectsBed>;

beforeEach(() => {
  bed = createProjectsBed();
});
afterEach(() => bed.dispose());

function setup() {
  const projects = createProjectsStore(bed.db);
  const boxes = createBoxStore(bed.db);
  const audit: unknown[] = [];
  for (const [id, ownerId] of [
    [A, "u1"],
    [B, "u2"],
  ] as const) {
    projects.insert({
      id,
      ownerId,
      root: `/boxes/${id}/project`,
      name: id,
      position: 1,
      createdAt: 0,
      kind: "box",
    });
    boxes.insert({
      projectId: id,
      resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
      hosts: [],
      scratch: false,
    });
  }
  return {
    projects,
    source: createProjectBoxSource(boxes, { append: (line) => void audit.push(line) }),
    audit,
  };
}

describe("project box source", () => {
  it("byPath matches the root and below by segment and refuses look-alikes (../, another uuid, projectX)", () => {
    const { source } = setup();
    const hit = { projectId: A, root: `/boxes/${A}/project` };
    expect(source.byPath("u1", `/boxes/${A}/project`)).toEqual(hit);
    expect(source.byPath("u1", `/boxes/${A}/project/src/a.ts`)).toEqual(hit);
    expect(source.byPath("u1", `/boxes/${A}`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}/projectX`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}/project/..`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}X/project`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}/project/../x`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}/./project`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}//project`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${A}/project/`)).toBeNull();
    expect(source.byPath("u1", `/boxes/${B}/project`)).toBeNull();
    expect(source.byPath("u2", `/boxes/${A}/project`)).toBeNull();
    expect(source.byPath("u1", "/boxes")).toBeNull();
    expect(source.byPath("u1", "boxes/x")).toBeNull();
  });

  it("reads the box row", () => {
    const { source } = setup();
    expect(source.box(A)).toMatchObject({
      ownerId: "u1",
      root: `/boxes/${A}/project`,
      hosts: [],
      deleting: false,
    });
    expect(source.box("nope")).toBeNull();
  });

  it("addHost adds exactly that host to that project, once, and audits it", () => {
    const { source, audit } = setup();
    source.addHost(A, "example.test", { actor: "user", actorId: "dev1" });
    source.addHost(A, "example.test", { actor: "user", actorId: "dev1" });
    expect(source.box(A)?.hosts).toEqual(["example.test"]);
    expect(source.box(B)?.hosts).toEqual([]);
    expect(audit).toEqual([
      expect.objectContaining({
        ownerId: "u1",
        reason: "project_host_added",
        detail: { projectId: A },
      }),
    ]);
  });

  it("addHost refuses a full list instead of dropping the host", () => {
    const { source, audit } = setup();
    for (let n = 0; n < AGENT_LIMITS.hosts; n += 1)
      source.addHost(A, `h${n}.example.test`, { actor: "user", actorId: "dev1" });
    expect(() => source.addHost(A, "one-more.example.test", { actor: "user", actorId: "dev1" })).toThrow(
      expect.objectContaining({ code: "limit_reached" }),
    );
    expect(source.box(A)?.hosts).toHaveLength(AGENT_LIMITS.hosts);
    expect(audit).toHaveLength(AGENT_LIMITS.hosts);
    expect(JSON.stringify(audit)).not.toContain("example.test");
  });

  it("old projects read as kind host", () => {
    const { projects } = setup();
    bed.db.run(
      "INSERT INTO projects (id, owner_id, root, name, position, created_at) VALUES ('old', 'u1', '/w/old', 'old', 2, 0)",
    );
    expect(projects.get("u1", "old")?.kind).toBe("host");
    expect(projects.get("u1", A)?.kind).toBe("box");
  });
});
