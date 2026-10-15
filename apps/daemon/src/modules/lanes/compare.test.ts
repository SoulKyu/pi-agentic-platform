import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Caller, lanesMethods, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { GitError } from "../../kernel/git/runner.ts";
import { type LaneBed, createLaneBed } from "../../kernel/testing/lane-bed.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createCompare } from "./compare.ts";
import { LANES_MIGRATIONS } from "./index.ts";
import { createLanesStore, type LanesStore } from "./store.ts";

const FANOUT = "1111111111111111";
let dir: string;
let db: Db;
let store: LanesStore;
let lb: LaneBed;
const logs = captureLogger();
const gitDirs = new Map<string, string>();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-compare-"));
  lb = createLaneBed();
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock: createFakeClock(),
    logger: logs.logger,
  }).db;
  store = createLanesStore(db);
  gitDirs.clear();
  store.insertFanout("u1", FANOUT, "go", 1);
});
afterEach(() => {
  db.close();
  lb.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const head = () => lb.bed.git(lb.bed.root, "rev-parse", "HEAD").trim();
async function addLane(
  id: string,
  slot: number,
  over: { owner?: string; session?: string | null; baseRef?: string } = {},
) {
  const { path, gitDir } = await lb.lane(id);
  gitDirs.set(path, gitDir);
  store.insert(
    {
      id: `${id}-0001`,
      ownerId: over.owner ?? "u1",
      createdBy: "session",
      projectRoot: lb.bed.root,
      worktree: path,
      branch: `pi/${id}`,
      baseRef: over.baseRef ?? "refs/heads/main",
      baseOid: head(),
      title: id,
      description: "x",
      source: null,
      model: null,
      fanoutId: FANOUT,
      fanoutSlot: slot,
    },
    1_000,
  );
  store.setState(`${id}-0001`, "active");
  if (over.session !== null) store.setPrimarySession(`${id}-0001`, over.session ?? `sess-${id}`);
  return { id: `${id}-0001`, path };
}

const texts = new Map<string, string | null>();
function compareWith(
  extra: {
    sessionCost?: (id: string) => number | null;
    sessions?: boolean;
    diskFloor?: (path: string) => undefined;
    readOnly?: boolean;
  } = {},
) {
  return createCompare({
    git: lb.git,
    logger: logs.logger,
    store,
    gitDirOf: (worktree) => gitDirs.get(worktree),
    indexDir: lb.indexDir,
    diskFloor: extra.diskFloor ?? (() => undefined),
    readOnly: extra.readOnly ?? false,
    sessions: () =>
      extra.sessions === false ? undefined : { lastAgentText: async (id: string) => texts.get(id) ?? null },
    ...(extra.sessionCost ? { sessionCost: extra.sessionCost } : {}),
  });
}
const caller = (over: Partial<Caller> = {}): Caller => testCaller(over);

describe("lanes.compare (M9R85)", () => {
  it("answers a column per lane with the summary, the file totals against the merge base, and the duration", async () => {
    const a = await addLane("a", 0);
    const b = await addLane("b", 1);
    writeFileSync(join(a.path, "a.txt"), "two\nthree\n");
    writeFileSync(join(a.path, "new.txt"), "x\ny\n");
    texts.set("sess-a", "I changed a.txt‮ and added new.txt");
    store.markFirstRunEnded(a.id, 4_000);
    const { columns } = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(columns).toEqual([
      {
        laneId: a.id,
        summary: "I changed a.txt and added new.txt",
        files: 2,
        additions: 4,
        deletions: 1,
        durationMs: 3_000,
        costUsd: null,
      },
      { laneId: b.id, summary: null, files: 0, additions: 0, deletions: 0, durationMs: null, costUsd: null },
    ]);
  });

  it("falls back to the stored base commit when the base branch is gone (T16-1)", async () => {
    const a = await addLane("a", 0, { baseRef: "refs/heads/deleted-base" });
    writeFileSync(join(a.path, "d.txt"), "1\n2\n");
    const { columns } = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(columns[0]).toMatchObject({ files: 1, additions: 2, deletions: 0 });
  });

  it("counts a committed change and a working change together, against the base the lane was cut from", async () => {
    const a = await addLane("a", 0);
    writeFileSync(join(a.path, "c.txt"), "1\n");
    lb.bed.git(a.path, "add", "c.txt");
    lb.bed.git(a.path, "commit", "-q", "-m", "c");
    writeFileSync(join(a.path, "d.txt"), "1\n2\n3\n");
    const { columns } = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(columns[0]).toMatchObject({ files: 2, additions: 4, deletions: 0 });
  });

  it("takes the cost from the sessions-cost port when it is wired, and null without it or without runs", async () => {
    const a = await addLane("a", 0);
    await addLane("b", 1, { session: null });
    const cost = vi.fn((id: string) => (id === "sess-a" ? 0.42 : null));
    const withPort = await compareWith({ sessionCost: cost })(caller(), { fanoutId: FANOUT });
    expect(withPort.columns.map((column) => column.costUsd)).toEqual([0.42, null]);
    expect(cost).toHaveBeenCalledTimes(1);
    expect(cost).toHaveBeenCalledWith("sess-a");
    const without = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(without.columns.map((column) => column.costUsd)).toEqual([null, null]);
    expect(a.id).toBe("a-0001");
  });

  it("cuts a summary to the contract's 600 characters, and leaves the counts of a lane without a worktree null", async () => {
    const a = await addLane("a", 0);
    texts.set("sess-a", "w".repeat(2000));
    store.setState(a.id, "archived", { at: 9 });
    const { columns } = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(columns[0]?.summary).toHaveLength(600);
    expect(columns[0]).toMatchObject({ files: null, additions: null, deletions: null });
  });

  it("refuses with the disk floor's error when the disk is full, and gives null counts in a read-only daemon (M5)", async () => {
    await addLane("a", 0);
    const full = compareWith({
      diskFloor: () => {
        throw new PapError("capacity");
      },
    });
    await expect(full(caller(), { fanoutId: FANOUT })).rejects.toMatchObject({ code: "capacity" });
    const floor = vi.fn((): undefined => undefined);
    const { columns } = await compareWith({ readOnly: true, diskFloor: floor })(caller(), {
      fanoutId: FANOUT,
    });
    expect(columns[0]).toMatchObject({ files: null, additions: null, deletions: null });
    expect(floor).not.toHaveBeenCalled();
  });

  it("gives a lane git cannot answer for null counts and keeps the others", async () => {
    const a = await addLane("a", 0);
    await addLane("b", 1);
    const failing = createCompare({
      git: {
        run: async (root, args, options) => {
          if (root === a.path && args[0] === "merge-base") throw new GitError("timeout");
          return lb.git.run(root, args, options);
        },
      },
      logger: logs.logger,
      store,
      gitDirOf: (worktree) => gitDirs.get(worktree),
      indexDir: lb.indexDir,
      diskFloor: () => undefined,
      readOnly: false,
      sessions: () => ({ lastAgentText: async () => null }),
    });
    const { columns } = await failing(caller(), { fanoutId: FANOUT });
    expect(columns.map((column) => column.files)).toEqual([null, 0]);
  });

  it("is not_found for another owner's group, a missing one, and answers capacity when the sessions port is unbound", async () => {
    await addLane("a", 0);
    const compare = compareWith();
    for (const asked of [
      compare({ ...caller(), userId: "u2" }, { fanoutId: FANOUT }),
      compare(caller(), { fanoutId: "2222222222222222" }),
    ])
      await expect(asked).rejects.toMatchObject({ code: "not_found" });
    await expect(compareWith({ sessions: false })(caller(), { fanoutId: FANOUT })).rejects.toMatchObject({
      code: "capacity",
    });
  });

  it("does not show a lane of another owner that shares the group id", async () => {
    await addLane("a", 0);
    await addLane("b", 1, { owner: "u2" });
    const { columns } = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(columns.map((column) => column.laneId)).toEqual(["a-0001"]);
  });

  it("builds columns the wire accepts", async () => {
    await addLane("a", 0);
    texts.set("sess-a", "ok");
    const answer = await compareWith()(caller(), { fanoutId: FANOUT });
    expect(lanesMethods["lanes.compare"].result.safeParse(answer).success).toBe(true);
  });
});
