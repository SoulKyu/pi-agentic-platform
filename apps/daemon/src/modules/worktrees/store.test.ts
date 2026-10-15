import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorktreesStore, type WorktreesStore } from "./store.ts";
import { createWorktreesBed, OID, type WorktreesBed } from "./testing/bed.ts";

let bed: WorktreesBed;
let store: WorktreesStore;
beforeEach(() => {
  bed = createWorktreesBed();
  store = createWorktreesStore(bed.db);
});
afterEach(() => bed.dispose());

const row = (n: number) => ({
  path: `/pap/worktrees/lane-${n}-1a2b`,
  workspaceId: "default",
  repoRoot: "/repo",
  branch: `pap/lane-${n}`,
  baseOid: OID,
  createdBranch: true,
});
const insertRaw = (overrides: Record<string, string | number>) =>
  bed.db.run(
    `INSERT INTO worktrees (path, owner_id, repo_root, branch, base_oid, created_branch, state, created_at, updated_at)
     VALUES ($path, 'o', '/repo', 'b', $oid, 1, $state, 1, 1)`,
    { path: "/p", oid: OID, state: "ready", ...overrides },
  );

describe("the migration's CHECKs", () => {
  it("refuses an unknown state, a relative path and a short oid", () => {
    expect(() => insertRaw({ state: "done" })).toThrow();
    expect(() => insertRaw({ path: "relative" })).toThrow();
    expect(() => insertRaw({ oid: "abc" })).toThrow();
    expect(() => insertRaw({})).not.toThrow();
  });
});

describe("reserve (M9R17 phase 1)", () => {
  it("writes the row creating with its dates", () => {
    store.reserve("o1", row(1), bed.clock.now(), () => {});
    expect(store.get(row(1).path)).toMatchObject({
      ownerId: "o1",
      state: "creating",
      createdBranch: true,
      createdAt: bed.clock.now(),
    });
  });

  it("refuses the fifth creating row of an owner with capacity, and leaves the others alone", () => {
    for (let n = 1; n <= 4; n += 1) store.reserve("o1", row(n), 1, () => {});
    expect(() => store.reserve("o1", row(5), 1, () => {})).toThrow(
      expect.objectContaining({ name: "PapError", code: "capacity" }),
    );
    expect(store.get(row(5).path)).toBeUndefined();
    expect(() => store.reserve("o2", row(5), 1, () => {})).not.toThrow();
  });

  it("frees the slot when a row leaves creating", () => {
    for (let n = 1; n <= 4; n += 1) store.reserve("o1", row(n), 1, () => {});
    store.setState(row(1).path, "ready", 2);
    expect(() => store.reserve("o1", row(5), 1, () => {})).not.toThrow();
  });

  it("runs the caller's check in the same transaction: its throw leaves no row, its reads see the earlier ones", () => {
    store.reserve("o1", row(1), 1, () => {});
    let seen = -1;
    store.reserve("o1", row(2), 1, (tx) => {
      seen = tx.get<{ n: number }>("SELECT count(*) AS n FROM worktrees")?.n ?? -1;
    });
    expect(seen).toBe(2 - 1);
    expect(() =>
      store.reserve("o1", row(3), 1, () => {
        throw new PapError("limit_reached");
      }),
    ).toThrow(expect.objectContaining({ code: "limit_reached" }));
    expect(store.get(row(3).path)).toBeUndefined();
  });
});
