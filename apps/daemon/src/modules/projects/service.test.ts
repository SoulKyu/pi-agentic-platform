import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createProjectsService, MAX_PROJECTS } from "./service.ts";
import { createBoxStore } from "./box-store.ts";
import { createProjectsStore } from "./store.ts";
import { createProjectsBed } from "./testing/bed.ts";

const caller = (userId: string) => testCaller({ userId });
let bed: ReturnType<typeof createProjectsBed>;
let service: ReturnType<typeof createProjectsService>;
let changes: Array<[string, unknown]>;

beforeEach(() => {
  bed = createProjectsBed();
  service = createProjectsService({
    boxes: createBoxStore(bed.db),
    store: createProjectsStore(bed.db),
    clock: bed.clock,
    logger: bed.logger,
    newId: bed.newId,
  });
  changes = [];
  service.onChange((ownerId, project) => changes.push([ownerId, project]));
});
afterEach(() => bed.dispose());

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return error instanceof PapError ? error.code : "other";
  }
  return undefined;
};

describe("projects in read-only mode", () => {
  it("maps SQLite's refusal to a write to read_only on update, rename and move alike", () => {
    const store = createProjectsStore(bed.db);
    service.ensure("u1", "/w/api");
    service.ensure("u1", "/w/web");
    const refuse = () => {
      throw new Error("attempt to write a readonly database");
    };
    const readOnly = createProjectsService({
      boxes: createBoxStore(bed.db),
      store: { ...store, rename: refuse, setPosition: refuse, renumber: refuse },
      clock: bed.clock,
      logger: bed.logger,
      newId: bed.newId,
    });
    expect(codeOf(() => readOnly.update(caller("u1"), "p1", { kind: "rename", name: "X" }))).toBe(
      "read_only",
    );
    expect(codeOf(() => readOnly.update(caller("u1"), "p1", { kind: "move", before: "p2" }))).toBe(
      "read_only",
    );
  });
});

describe("projects", () => {
  it("makes a project once per owner and root, named after its folder, each new one on top", () => {
    expect(service.ensure("u1", "/w/api")).toEqual({ id: "p1", root: "/w/api", name: "api", position: -1 });
    expect(service.ensure("u1", "/w/web")).toEqual({ id: "p2", root: "/w/web", name: "web", position: -2 });
    expect(service.ensure("u1", "/w/api")?.id).toBe("p1");
    expect(service.ensure("u2", "/w/api")?.id).toBe("p3");
    expect(changes.map(([owner, project]) => [owner, (project as { id: string }).id])).toEqual([
      ["u1", "p1"],
      ["u1", "p2"],
      ["u2", "p3"],
    ]);
    expect(service.ensure("u1", "/")?.name).toBe("/");
  });

  it("answers null for a root it cannot use", () => {
    for (const root of ["relative/dir", "", "/a\u0000b", "/a\nb", `/${"a".repeat(4096)}`])
      expect(service.ensure("u1", root), JSON.stringify(root)).toBeNull();
  });

  it("answers null past MAX_PROJECTS, and says so once a minute", async () => {
    const store = createProjectsStore(bed.db);
    // One transaction: 2 000 autocommits are 2 000 fsyncs (M4R130).
    bed.db.transaction(() => {
      for (let i = 0; i < MAX_PROJECTS; i++)
        store.insert({
          id: `x${i}`,
          ownerId: "u1",
          root: `/r/${i}`,
          name: `r${i}`,
          position: i,
          createdAt: 0,
        });
    });
    expect(service.ensure("u1", "/w/new")).toBeNull();
    expect(service.ensure("u1", "/w/new2")).toBeNull();
    expect(bed.lines.filter((line) => line.msg === "projects_full")).toHaveLength(1);
    await bed.clock.advance(60_000);
    expect(service.ensure("u1", "/w/new3")).toBeNull();
    expect(bed.lines.filter((line) => line.msg === "projects_full")).toHaveLength(2);
  });

  it("renames with a clean name, refuses an empty one and another owner's project", () => {
    service.ensure("u1", "/w/api");
    changes = [];
    service.update(caller("u1"), "p1", { kind: "rename", name: "  The\u202E   API\n" });
    expect(service.list("u1", ["p1"])).toEqual([{ id: "p1", root: "/w/api", name: "The API", position: -1 }]);
    expect(changes).toHaveLength(1);
    expect(codeOf(() => service.update(caller("u1"), "p1", { kind: "rename", name: "\u200B" }))).toBe(
      "bad_request",
    );
    expect(codeOf(() => service.update(caller("u2"), "p1", { kind: "rename", name: "x" }))).toBe("not_found");
    expect(codeOf(() => service.update(caller("u1"), "nope", { kind: "move", before: null }))).toBe(
      "not_found",
    );
  });

  it("moves one project and publishes that one only", () => {
    for (const root of ["/w/a", "/w/b", "/w/c"]) service.ensure("u1", root); // a -1, b -2, c -3: order c, b, a
    changes = [];
    service.update(caller("u1"), "p1", { kind: "move", before: "p3" }); // a above c
    expect(service.list("u1", ["p1", "p2", "p3"]).map((p) => p.id)).toEqual(["p1", "p3", "p2"]);
    expect(changes.map(([, project]) => (project as { id: string }).id)).toEqual(["p1"]);
    service.update(caller("u1"), "p3", { kind: "move", before: null }); // c last
    expect(service.list("u1", ["p1", "p2", "p3"]).map((p) => p.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("renumbers when two positions get too close, and then publishes every project", () => {
    const store = createProjectsStore(bed.db);
    store.insert({ id: "a", ownerId: "u1", root: "/a", name: "a", position: 1, createdAt: 0 });
    store.insert({ id: "b", ownerId: "u1", root: "/b", name: "b", position: 1 + 5e-7, createdAt: 0 });
    store.insert({ id: "c", ownerId: "u1", root: "/c", name: "c", position: 2, createdAt: 0 });
    service.update(caller("u1"), "c", { kind: "move", before: "b" });
    expect(service.list("u1", ["a", "b", "c"])).toEqual([
      { id: "a", root: "/a", name: "a", position: 1 },
      { id: "c", root: "/c", name: "c", position: 2 },
      { id: "b", root: "/b", name: "b", position: 3 },
    ]);
    expect(changes).toHaveLength(3);
  });

  it("a listener that throws does not stop the others, and a removed one hears nothing", () => {
    const after = vi.fn();
    service.onChange(() => {
      throw new Error("boom");
    });
    const off = service.onChange(after);
    service.ensure("u1", "/w/x");
    off();
    service.ensure("u1", "/w/y");
    expect(after).toHaveBeenCalledOnce();
    expect(bed.lines.some((line) => line.msg === "projects_listener_failed")).toBe(true);
  });

  it("lists only the owner's projects", () => {
    service.ensure("u1", "/w/api");
    expect(service.list("u2", ["p1"])).toEqual([]);
    expect(service.list("u1", ["p1"])).toHaveLength(1);
  });

  it("sends a project to the end when it is moved before itself, an unknown id or another owner's", () => {
    for (const root of ["/w/a", "/w/b"]) service.ensure("u1", root); // order p2, p1
    service.ensure("u2", "/w/c"); // p3
    const order = () => service.list("u1", ["p1", "p2"]).map((p) => p.id);
    service.update(caller("u1"), "p2", { kind: "move", before: "p2" });
    expect(order()).toEqual(["p1", "p2"]);
    service.update(caller("u1"), "p2", { kind: "move", before: "p2" });
    service.update(caller("u1"), "p1", { kind: "move", before: "nope" });
    expect(order()).toEqual(["p2", "p1"]);
    service.update(caller("u1"), "p2", { kind: "move", before: "p3" });
    expect(order()).toEqual(["p1", "p2"]);
  });
});

describe("roots", () => {
  it("lists the owner's roots, newest first, and none of another owner's", async () => {
    service.ensure("u1", "/w/api");
    await bed.clock.advance(10);
    service.ensure("u2", "/w/other");
    await bed.clock.advance(10);
    service.ensure("u1", "/w/web");
    expect(service.roots("u1")).toEqual(["/w/web", "/w/api"]);
    expect(service.roots("u2")).toEqual(["/w/other"]);
    expect(service.roots("u3")).toEqual([]);
  });
});

describe("covers", () => {
  it("is true for a project's root and any folder inside it, for that owner only", () => {
    service.ensure("u1", "/w/api");
    expect(service.covers("u1", "/w/api")).toBe(true);
    expect(service.covers("u1", "/w/api/src/deep")).toBe(true);
    expect(service.covers("u2", "/w/api")).toBe(false);
  });

  it("is false for a sibling that shares a prefix, a parent, and anything that is not a clean absolute path", () => {
    service.ensure("u1", "/w/api");
    for (const path of [
      "/w/api2",
      "/w",
      "/",
      "w/api",
      "/w/api/../web",
      "/w/api/./src",
      "/w/api//src",
      "",
      "/w/api\0",
    ])
      expect(service.covers("u1", path), path).toBe(false);
  });

  it("holds for a project at the filesystem root", () => {
    service.ensure("u1", "/");
    expect(service.covers("u1", "/etc")).toBe(true);
  });
});

describe("coversHost (what Pi's helpers may open)", () => {
  const BOX = "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11";
  const boxRoot = `/boxes/${BOX}/project`;
  const insertBox = (root: string) => {
    createProjectsStore(bed.db).insert({
      id: BOX,
      ownerId: "u1",
      root,
      name: "box",
      position: 1,
      createdAt: 0,
      kind: "box",
    });
  };

  it("answers like covers for a host project", () => {
    service.ensure("u1", "/w/api");
    expect(service.coversHost("u1", "/w/api/src")).toBe(true);
    expect(service.coversHost("u2", "/w/api")).toBe(false);
  });

  it("is false for a box project's root and anything under it, though covers is true", () => {
    insertBox(boxRoot);
    expect(service.covers("u1", `${boxRoot}/src`)).toBe(true);
    expect(service.coversHost("u1", boxRoot)).toBe(false);
    expect(service.coversHost("u1", `${boxRoot}/src`)).toBe(false);
  });

  it("is false for a box path even when a host project root encloses it", () => {
    service.ensure("u1", "/");
    insertBox(boxRoot);
    expect(service.coversHost("u1", "/etc")).toBe(true);
    expect(service.coversHost("u1", `${boxRoot}/src`)).toBe(false);
  });
});
