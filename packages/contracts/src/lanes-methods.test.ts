import { describe, expect, it } from "vitest";
import { lanesMethods } from "./lanes-methods.ts";
import { methods } from "./index.ts";

const laneId = "fix-it-a3f9";
const create = {
  projectRoot: "/home/me/repo",
  title: "Fix it",
  description: "do it",
  models: [null],
};

describe("lanes methods", () => {
  it("declares only lanes:* permissions and is spread into the catalogue", () => {
    for (const def of Object.values(lanesMethods)) {
      expect(def.permission.startsWith("lanes:")).toBe(true);
      expect(methods[def.name]).toBe(def);
    }
  });
  it("declares disk_low on every method whose lane paths cross the disk floor (M10 on M9)", () => {
    const crossing = [
      "lanes.create",
      "lanes.restore",
      "lanes.review",
      "lanes.checkpointStatus",
      "lanes.suggestCommit",
      "lanes.compare",
    ] as const;
    for (const name of crossing)
      expect([name, lanesMethods[name].errors]).toEqual([name, expect.arrayContaining(["disk_low"])]);
  });
  it("keeps admin to what runs code, sends it out, reaches a forge or destroys work", () => {
    const admin = Object.values(lanesMethods)
      .filter((def) => def.permission === "lanes:admin")
      .map((def) => def.name.replace("lanes.", ""))
      .sort();
    expect(admin).toEqual([
      "approveScripts",
      "archive",
      "closeLosers",
      "issue",
      "prCreate",
      "prRefresh",
      "push",
      "restore",
      "runScript",
    ]);
  });
  it("lanes.create refuses a blank description without an issue and five models", () => {
    const { params } = lanesMethods["lanes.create"];
    expect(params.safeParse(create).success).toBe(true);
    expect(params.safeParse({ ...create, description: "  " }).success).toBe(false);
    expect(params.safeParse({ ...create, models: Array(5).fill(null) }).success).toBe(false);
    expect(params.safeParse({ ...create, models: Array(4).fill(null) }).success).toBe(true);
  });
  it("lanes.restore takes a session or an undo, and its result needs changed", () => {
    const { params, result } = lanesMethods["lanes.restore"];
    expect(params.safeParse({ laneId, sessionId: "s" }).success).toBe(true);
    expect(params.safeParse({ laneId, undo: true }).success).toBe(true);
    expect(params.safeParse({ laneId }).success).toBe(false);
    expect(result.safeParse({ ok: true }).success).toBe(false);
    expect(result.safeParse({ ok: true, changed: false }).success).toBe(true);
    const left = { path: "big.bin", reason: "large" };
    expect(result.safeParse({ ok: true, changed: true, left: [left], leftTotal: 1 }).success).toBe(true);
    expect(result.safeParse({ ok: true, changed: true, left: [{ ...left, reason: "other" }] }).success).toBe(
      false,
    );
    expect(result.safeParse({ ok: true, changed: true, left: Array(51).fill(left) }).success).toBe(false);
  });
  it("lanes.checkpointStatus names the root checkpoint with a null entry id", () => {
    const { result } = lanesMethods["lanes.checkpointStatus"];
    const status = { exact: true, differs: false, undoAvailable: false };
    expect(result.safeParse({ ...status, target: { entryId: null, turn: null } }).success).toBe(true);
    expect(result.safeParse({ ...status, target: { entryId: "bad id", turn: 1 } }).success).toBe(false);
  });
  it("lanes.runScript answers tainted and not_active and takes confirmTainted", () => {
    const { params, result } = lanesMethods["lanes.runScript"];
    expect(params.safeParse({ laneId, kind: "setup", confirmTainted: true }).success).toBe(true);
    for (const reason of ["tainted", "not_active"])
      expect(result.safeParse({ ok: false, reason }).success, reason).toBe(true);
  });
  it("declares read_only on the write methods that throw it (T14-M1)", () => {
    for (const name of ["lanes.commit", "lanes.push", "lanes.prCreate"] as const)
      expect(lanesMethods[name].errors, name).toContain("read_only");
  });
  it("declares read_only on the three reads that snapshot the worktree (N2)", () => {
    for (const name of ["lanes.review", "lanes.checkpointStatus", "lanes.suggestCommit"] as const)
      expect(lanesMethods[name].errors, name).toContain("read_only");
  });
  it("lanes.suggestCommit is a mutation: a model call costs money", () => {
    expect(lanesMethods["lanes.suggestCommit"].idempotent).toBe(false);
  });
  it("lanes.reviewState.set refuses a doc over the caps", () => {
    const { params } = lanesMethods["lanes.reviewState.set"];
    const seen = { path: "a", identity: "deleted" };
    expect(params.safeParse({ laneId, baseRevision: 0, doc: { seen: [seen], comments: [] } }).success).toBe(
      true,
    );
    expect(
      params.safeParse({ laneId, baseRevision: 0, doc: { seen: Array(2001).fill(seen), comments: [] } })
        .success,
    ).toBe(false);
  });
});
