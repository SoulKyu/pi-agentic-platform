import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { harness, makeRelease, type Harness } from "../testing/apply-harness.ts";
import { afterUpdate, migrateDb, writeBuildInfo } from "../testing/update-ops.ts";
import { ManualRollbackRefused, planManualRollback } from "./manual-rollback.ts";
import { pendingPath, writePending } from "./pending.ts";
import { snapshotDatabase } from "../ops/snapshot.ts";

let h: Harness | undefined;
afterEach(() => h?.cleanup());
const NOW = new Date("2026-10-17T12:00:00.000Z");

const plan = (to?: string, keepDatabase = false) => {
  if (h === undefined) throw new Error("no harness");
  return planManualRollback({
    app: h.app,
    home: h.home,
    ...(to === undefined ? {} : { to }),
    keepDatabase,
    now: NOW,
  });
};
const refusal = (to?: string): string => {
  try {
    plan(to);
  } catch (error) {
    if (error instanceof ManualRollbackRefused) return error.message;
    throw error;
  }
  return "";
};

describe("target choice", () => {
  it("is the newest other complete release by BUILD_INFO builtAt", () => {
    h = harness();
    makeRelease(h.app, "mid");
    writeBuildInfo(h, "mid", "2026-10-01T00:00:00.000Z");
    afterUpdate(h);
    expect(plan().target).toBe("mid");
  });

  it("--to names another complete release", () => {
    h = harness();
    makeRelease(h.app, "mid");
    writeBuildInfo(h, "mid", "2026-10-01T00:00:00.000Z");
    afterUpdate(h);
    expect(plan("old").target).toBe("old");
  });

  it("the synthetic pending goes back to the target from the current release at the rolling_back step", () => {
    h = harness();
    const name = afterUpdate(h);
    expect(plan().pending).toEqual({
      format: 1,
      from: "old",
      to: "new",
      step: "rolling_back",
      snapshot: name,
      schemaBefore: ["001"],
      startedAt: "2026-10-17T12:00:00.000Z",
    });
  });
});

describe("refusals", () => {
  it("pending.json exists: run recover first (a valid one and a damaged one)", () => {
    h = harness();
    afterUpdate(h);
    writePending(h.home, {
      format: 1,
      from: "old",
      to: "new",
      step: "started",
      snapshot: null,
      schemaBefore: null,
      startedAt: "2026-10-17T10:00:00.000Z",
    });
    expect(refusal()).toContain("pap update recover");
    writeFileSync(pendingPath(h.home), "{not json");
    expect(refusal()).toContain("pap update recover");
  });

  it("no installed release", () => {
    h = harness();
    mkdirSync(join(h.root, "empty-app"), { recursive: true });
    expect(() =>
      planManualRollback({ app: join(h?.root ?? "", "empty-app"), home: h?.home ?? "", now: NOW }),
    ).toThrow(/no installed release/);
  });

  it("no other complete release", () => {
    h = harness();
    afterUpdate(h);
    rmSync(join(h.app, "releases", "old", "node", "bin", "node")); // `old` is incomplete
    mkdirSync(join(h.app, "releases", "half"), { recursive: true });
    expect(refusal()).toContain("no other complete release");
  });

  it("--to the current release", () => {
    h = harness();
    afterUpdate(h);
    expect(refusal("new")).toContain("already the current release");
  });

  it("--to an incomplete or missing release, and an invalid id", () => {
    h = harness();
    afterUpdate(h);
    mkdirSync(join(h.app, "releases", "half"), { recursive: true });
    expect(refusal("half")).toContain("incomplete");
    expect(refusal("ghost")).toContain("incomplete");
    expect(refusal("..")).toContain("not a release id");
    expect(refusal("a/b")).toContain("not a release id");
  });
});

describe("needsDecision and lostSince", () => {
  it("false when the database holds only ids the snapshot has", () => {
    h = harness();
    afterUpdate(h);
    const result = plan();
    expect(result.needsDecision).toBe(false);
    expect(result.lostSince).toBeNull();
    expect(result.unknownSchema).toBe(false);
  });

  it("true exactly when the database has an id the snapshot lacks, with the snapshot's time", () => {
    h = harness();
    afterUpdate(h);
    migrateDb(h);
    const result = plan();
    expect(result.needsDecision).toBe(true);
    expect(result.lostSince).toBe("2026-10-17T10:00:00.000Z");
    expect(result.pending.snapshot).not.toBeNull();
  });

  it("false when the snapshot has MORE ids than the database", () => {
    h = harness();
    migrateDb(h);
    afterUpdate(h); // snapshot holds 001 and 002
    const db = new DatabaseSync(join(h.home, "state.db"));
    db.exec("DELETE FROM schema_migrations WHERE id = '002'");
    db.close();
    expect(plan().needsDecision).toBe(false);
  });

  it("the newest matching snapshot decides, and another release's snapshot is ignored", () => {
    h = harness();
    afterUpdate(h, "2026-10-16T10-00-00-000Z"); // 001 only
    migrateDb(h);
    snapshotDatabase(
      join(h.home, "state.db"),
      join(h.home, "backups", "pre-update-new-2026-10-17T09-00-00-000Z.db"),
    ); // newest: 001 and 002
    snapshotDatabase(
      join(h.home, "state.db"),
      join(h.home, "backups", "pre-update-new-x-2026-10-18T09-00-00-000Z.db"),
    ); // the release `new-x`, not `new`
    const result = plan();
    expect(result.pending.snapshot).toBe("pre-update-new-2026-10-17T09-00-00-000Z.db");
    expect(result.needsDecision).toBe(false);
  });

  it("a damaged database with a good snapshot needs a decision", () => {
    h = harness();
    afterUpdate(h);
    writeFileSync(join(h.home, "state.db"), "garbage");
    expect(plan().needsDecision).toBe(true);
  });

  it("no snapshot: no decision, unknownSchema when a database exists, schemaBefore null", () => {
    h = harness();
    migrateDb(h);
    rmSync(join(h.home, "backups", afterUpdate(h))); // no snapshot of `new`
    const result = plan("old");
    expect(result.needsDecision).toBe(false);
    expect(result.unknownSchema).toBe(true);
    expect(result.pending.snapshot).toBeNull();
    expect(result.pending.schemaBefore).toBeNull();
  });

  it("a damaged snapshot counts as none", () => {
    h = harness();
    const name = afterUpdate(h);
    migrateDb(h);
    writeFileSync(join(h.home, "backups", name), "garbage");
    const result = plan();
    expect(result.pending.snapshot).toBeNull();
    expect(result.unknownSchema).toBe(true);
  });

  it("no database at all: nothing to decide, nothing unknown", () => {
    h = harness({ withDb: false });
    afterUpdate(h); // no database: no snapshot is taken
    const result = plan();
    expect(result.needsDecision).toBe(false);
    expect(result.unknownSchema).toBe(false);
  });

  it("--keep-database: the synthetic pending carries neither the snapshot nor its ids", () => {
    h = harness();
    afterUpdate(h);
    migrateDb(h);
    const result = plan(undefined, true);
    expect(result.pending.snapshot).toBeNull();
    expect(result.pending.schemaBefore).toBeNull();
    expect(result.needsDecision).toBe(true);
  });
});
