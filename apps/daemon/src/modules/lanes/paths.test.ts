import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { createLanePaths } from "./paths.ts";
import { createLanesStore, type LanesStore } from "./store.ts";

let dir: string;
let db: Db;
let store: LanesStore;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-lane-paths-")));
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock: createFakeClock(),
    logger: captureLogger().logger,
  }).db;
  store = createLanesStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const OID = "a".repeat(40);
const add = (
  id: string,
  ownerId: string,
  projectRoot: string,
  state: "active" | "archiving" | "archived" | "failed" = "active",
) => {
  const worktree = join(dir, "pap", "worktrees", id);
  mkdirSync(worktree, { recursive: true });
  store.insert(
    {
      id,
      ownerId,
      createdBy: "session",
      projectRoot,
      worktree,
      branch: `pi/${id}`,
      baseRef: "main",
      baseOid: OID,
      title: id,
      description: "",
      source: null,
      model: null,
    },
    1,
  );
  if (state !== "active") store.setState(id, state, state === "failed" ? { failedReason: "git" } : { at: 2 });
  return worktree;
};

describe("LanePaths", () => {
  it("maps the worktree and a subfolder to the project root, a sibling lane to its own project", () => {
    const a = add("a-0001", "u1", "/srv/one");
    const b = add("b-0001", "u1", "/srv/two");
    const paths = createLanePaths(store);
    paths.rebuild();
    mkdirSync(join(a, "src", "deep"), { recursive: true });
    expect(paths.scopeOf(a)).toBe("/srv/one");
    expect(paths.scopeOf(join(a, "src", "deep"))).toBe("/srv/one");
    expect(paths.scopeOf(b)).toBe("/srv/two");
  });

  it("answers null for a folder that is no lane, one that merely shares a prefix, and the worktrees folder", () => {
    const a = add("a-0001", "u1", "/srv/one");
    const paths = createLanePaths(store);
    paths.rebuild();
    mkdirSync(`${a}-sibling`);
    expect(paths.scopeOf(dir)).toBeNull();
    expect(paths.scopeOf(`${a}-sibling`)).toBeNull();
    expect(paths.scopeOf(join(dir, "pap", "worktrees"))).toBeNull();
    expect(paths.laneOf(dir)).toBeNull();
  });

  it("maps a symlink to a worktree to its project (real path), and a link out of one to nothing", () => {
    const a = add("a-0001", "u1", "/srv/one");
    const paths = createLanePaths(store);
    paths.rebuild();
    const link = join(dir, "link-to-lane");
    symlinkSync(a, link);
    expect(paths.scopeOf(link)).toBe("/srv/one");
    const outside = join(dir, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(a, "escape"));
    expect(paths.scopeOf(join(a, "escape"))).toBeNull();
  });

  it("lists in roots() only the owner's non-archived worktrees", () => {
    const a = add("a-0001", "u1", "/srv/one");
    add("b-0001", "u1", "/srv/one", "archived");
    add("c-0001", "u1", "/srv/one", "failed");
    const d = add("d-0001", "u2", "/srv/other");
    const e = add("e-0001", "u1", "/srv/one", "archiving");
    const paths = createLanePaths(store);
    paths.rebuild();
    expect([...paths.roots("u1")].sort()).toEqual([a, e].sort());
    expect(paths.roots("u2")).toEqual([d]);
    expect(paths.roots("nobody")).toEqual([]);
  });

  it("answers closed() archiving and archived for those lanes' folders, also gone ones, and null for an active lane", () => {
    const live = add("a-0001", "u1", "/srv/one");
    const closing = add("b-0001", "u1", "/srv/one", "archiving");
    const gone = add("c-0001", "u1", "/srv/one", "archived");
    rmSync(gone, { recursive: true });
    const paths = createLanePaths(store);
    paths.rebuild();
    expect(paths.closed(live)).toBeNull();
    expect(paths.closed(closing)).toBe("archiving");
    expect(paths.closed(join(closing, "sub"))).toBe("archiving");
    expect(paths.closed(gone)).toBe("archived");
    expect(paths.closed(join(gone, "sub"))).toBe("archived");
    expect(paths.closed(dir)).toBeNull();
  });

  it("is rebuilt from the store: a new lane and an archive show at the next rebuild", () => {
    const paths = createLanePaths(store);
    paths.rebuild();
    const a = add("a-0001", "u1", "/srv/one");
    expect(paths.scopeOf(a)).toBeNull();
    paths.rebuild();
    expect(paths.scopeOf(a)).toBe("/srv/one");
    store.setState("a-0001", "archived", { at: 3 });
    paths.rebuild();
    expect(paths.roots("u1")).toEqual([]);
    expect(paths.closed(a)).toBe("archived");
  });

  it("returns the lane row for laneOf, and refuses another owner's lane (forbidden)", () => {
    const a = add("a-0001", "u1", "/srv/one");
    const paths = createLanePaths(store);
    paths.rebuild();
    expect(paths.laneOf(join(a, "x"))?.id).toBe("a-0001");
    expect(() => paths.assertOwnLane("u1", a)).not.toThrow();
    expect(() => paths.assertOwnLane("u2", a)).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(() => paths.assertOwnLane("u2", join(a, "deep", "er"))).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => paths.assertOwnLane("u2", dir)).not.toThrow();
  });
});
