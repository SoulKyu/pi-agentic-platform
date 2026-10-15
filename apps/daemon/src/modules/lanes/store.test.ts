import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { createLanesStore, type LanesStore, type NewLane } from "./store.ts";
import { tempHome } from "./testing/script-fakes.ts";

let db: Db;
let store: LanesStore;
let home: ReturnType<typeof tempHome>;

beforeEach(() => {
  home = tempHome();
  db = migrate({
    dbPath: join(home.dir, "state.db"),
    backupsDir: join(home.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock: createFakeClock(),
    logger: captureLogger().logger,
  }).db;
  store = createLanesStore(db);
});
afterEach(() => {
  db.close();
  home.dispose();
});

const OID = "a".repeat(40);
const lane = (id: string, over: Partial<NewLane> = {}): NewLane => ({
  id,
  ownerId: "u1",
  createdBy: "session",
  projectRoot: "/srv/project",
  worktree: `/srv/pap/worktrees/${id}`,
  branch: `pi/${id}`,
  baseRef: "refs/heads/main",
  baseOid: OID,
  title: `Title ${id}`,
  description: "d",
  source: null,
  model: null,
  ...over,
});

/** The columns the migration's CHECKs judge, as raw SQL: what the store writes must pass, anything else must not. */
const raw = (over: Record<string, string | number | null> = {}) => {
  const row = {
    id: "raw-0001",
    owner_id: "u1",
    created_by: "session",
    project_root: "/srv/project",
    worktree: "/srv/pap/worktrees/raw-0001",
    branch: "pi/raw",
    base_ref: "main",
    base_oid: OID,
    title: "t",
    description: "",
    source: null as string | null,
    fanout_id: null as string | null,
    fanout_slot: null as number | null,
    setup_state: "none",
    failed_reason: null as string | null,
    script_pgid: null as number | null,
    state: "creating",
    created_at: 1,
    ...over,
  };
  const names = Object.keys(row);
  db.run(
    `INSERT INTO lanes (${names.join(", ")}) VALUES (${names.map((name) => `$${name}`).join(", ")})`,
    row as Record<string, string | number | null>,
  );
};

describe("the lanes schema's CHECKs", () => {
  it("accepts the base row", () => expect(() => raw()).not.toThrow());

  it.each([
    ["an unknown fan-out", { fanout_id: "f".repeat(16) }],
    ["slot 4", { fanout_slot: 4 }],
    ["an empty title", { title: "" }],
    ["a source that is not JSON", { source: "{nope" }],
    ["an unknown setup state", { setup_state: "launched" }],
    ["created_by api", { created_by: "api" }],
    ["an unknown failed reason", { failed_reason: "boom" }],
    ["script_pgid 1", { script_pgid: 1 }],
  ])("refuses %s", (_name, over) => {
    expect(() => raw(over)).toThrow();
  });

  it("refuses a duplicate worktree", () => {
    raw();
    expect(() => raw({ id: "raw-0002" })).toThrow();
  });

  it("refuses a 24 001-character fan-out prompt, and takes 24 000", () => {
    const insert = (length: number, id: string) =>
      db.run("INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ($id, 'u1', $prompt, 1)", {
        id,
        prompt: "x".repeat(length),
      });
    expect(() => insert(24_001, "f1")).toThrow();
    expect(() => insert(24_000, "f2")).not.toThrow();
  });

  it("refuses a review for an unknown lane and an approval of kind deploy", () => {
    expect(() =>
      db.run("INSERT INTO lane_reviews (lane_id, owner_id, doc, revision) VALUES ('nope', 'u1', '{}', 1)"),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO lane_script_approvals (owner_id, project_root, kind, sha256, script, approved_at)
         VALUES ('u1', '/p', 'deploy', $sha, 'x', 1)`,
        { sha: "0".repeat(64) },
      ),
    ).toThrow();
  });
});

describe("LanesStore", () => {
  it("inserts a lane as creating and reads it back, owner-scoped", () => {
    store.insert(
      lane("fix-0001", {
        source: { kind: "description" },
        model: { provider: "p", modelId: "m", thinking: "high" },
      }),
      10,
    );
    expect(store.get("fix-0001")).toMatchObject({
      id: "fix-0001",
      ownerId: "u1",
      state: "creating",
      failedReason: null,
      primarySessionId: null,
      setupState: "none",
      testState: "none",
      createdAt: 10,
      source: { kind: "description" },
      model: { provider: "p", modelId: "m", thinking: "high" },
    });
    expect(store.getOwned("u1", "fix-0001")?.id).toBe("fix-0001");
    expect(store.getOwned("u2", "fix-0001")).toBeUndefined();
    expect(store.get("missing-0001")).toBeUndefined();
  });

  it("counts open lanes: creating, active, archiving and failed, not archived", () => {
    for (const [id, state] of [
      ["a-0001", "creating"],
      ["b-0001", "active"],
      ["c-0001", "archiving"],
      ["d-0001", "failed"],
      ["e-0001", "archived"],
    ] as const) {
      store.insert(lane(id), 1);
      store.setState(id, state, state === "failed" ? { failedReason: "git" } : { at: 5 });
    }
    store.insert(lane("z-0001", { ownerId: "u2" }), 1);
    expect(store.countOpen("u1")).toBe(4);
    expect(store.get("d-0001")?.failedReason).toBe("git");
    expect(store.get("e-0001")?.archivedAt).toBe(5);
  });

  it("lists open lanes newest first and pages archived ones by (archived_at, id) newest first", () => {
    store.insert(lane("old-0001"), 1);
    store.insert(lane("new-0001"), 2);
    expect(store.open("u1").map((row) => row.id)).toEqual(["new-0001", "old-0001"]);
    for (const [id, at] of [
      ["p-0001", 10],
      ["q-0001", 10],
      ["r-0001", 20],
      ["s-0001", 5],
    ] as const) {
      store.insert(lane(id), 1);
      store.setState(id, "archived", { at });
    }
    expect(store.archivedCount("u1")).toBe(4);
    expect(store.archivedPage("u1", null, 3).map((row) => row.id)).toEqual(["r-0001", "q-0001", "p-0001"]);
    expect(store.archivedPage("u1", { archivedAt: 10, id: "q-0001" }, 5).map((row) => row.id)).toEqual([
      "p-0001",
      "s-0001",
    ]);
    expect(store.archivedPage("u2", null, 5)).toEqual([]);
  });

  it("sets the primary session and the setup states pap itself decides", () => {
    store.insert(lane("a-0001"), 1);
    store.setPrimarySession("a-0001", "sess-1");
    store.setSetupState("a-0001", "pending");
    expect(store.get("a-0001")).toMatchObject({ primarySessionId: "sess-1", setupState: "pending" });
  });

  it("keeps the pull request number and URL of a lane (Task 14)", () => {
    store.insert(lane("a-0001"), 1);
    expect(store.get("a-0001")).toMatchObject({ prNumber: null, prUrl: null });
    store.setPr("a-0001", 7, "https://github.com/o/r/pull/7");
    expect(store.get("a-0001")).toMatchObject({ prNumber: 7, prUrl: "https://github.com/o/r/pull/7" });
    expect(() => store.setPr("a-0001", 0, "https://x")).toThrow();
  });

  it("names the fan-outs of lanes with the lanes of each in slot order", () => {
    db.run("INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ('f1', 'u1', 'go', 3)");
    raw({ id: "s1-0001", worktree: "/w/1", fanout_id: "f1", fanout_slot: 1 });
    raw({ id: "s0-0001", worktree: "/w/0", fanout_id: "f1", fanout_slot: 0 });
    expect(store.fanouts("u1", ["f1"])).toEqual([
      { id: "f1", prompt: "go", createdAt: 3, laneIds: ["s0-0001", "s1-0001"] },
    ]);
    expect(store.fanouts("u2", ["f1"])).toEqual([]);
    expect(store.fanouts("u1", [])).toEqual([]);
  });

  it("lists the lanes paths are built from: all but the failed ones", () => {
    store.insert(lane("a-0001"), 1);
    store.insert(lane("b-0001"), 1);
    store.setState("b-0001", "failed", { failedReason: "prepare" });
    expect(store.tracked().map((row) => row.id)).toEqual(["a-0001"]);
  });
});
