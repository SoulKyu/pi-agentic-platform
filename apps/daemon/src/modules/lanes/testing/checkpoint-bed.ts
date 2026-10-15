import { vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { LeftEntry } from "../../../kernel/git/snapshot.ts";
import type { GitRunner } from "../../../kernel/git/runner.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import type { LaneRunInfo } from "../../sessions/index.ts";
import {
  type CheckpointDeps,
  type CheckpointKernel,
  createCheckpoints,
  createLaneLocks,
  createLaneNotices,
  createRestorer,
  type LaneRow,
  type RestoreDeps,
} from "../index.ts";

export const LANE_ID = "demo-0a1b";
export const WORKTREE = "/srv/wt/demo";
export const GIT_DIR = "/srv/repo/.git/worktrees/demo";
export const REF = (key: string): string => `refs/pap/checkpoints/${LANE_ID}/${key}`;
export const oid = (n: number): string => String(n).padStart(40, "0");

export const LANE = {
  id: LANE_ID,
  ownerId: "u1",
  worktree: WORKTREE,
  projectRoot: "/srv/repo",
  state: "active",
} as LaneRow;

/** The fakes a checkpoint unit test drives: git, the kernel, the sessions port, the notices and the order of events. */
export function createCheckpointBed(over: { state?: LaneRow["state"]; readOnly?: boolean } = {}) {
  const clock = createFakeClock();
  const log: string[] = [];
  const refs = new Map<string, string>();
  const changed: string[] = [];
  const notices = createLaneNotices(clock, (laneId) => void changed.push(laneId));
  const lane = { ...LANE, state: over.state ?? "active" } as LaneRow;
  const locks = createLaneLocks((cwd) => (cwd.startsWith(WORKTREE) ? LANE_ID : null));

  const behaviour = {
    /** Runs inside every capture, after it started. */
    capture: async (): Promise<void> => undefined,
    skipped: 0,
    /** The tree of the n-th capture. */
    tree: (n: number): string => `tree-${n}`,
    treeOfCommit: (commit: string): string => `tree-of-${commit}`,
    left: [] as LeftEntry[],
    restore: async (): Promise<{ removed: number; left: LeftEntry[] }> => ({ removed: 0, left: [] }),
    diskFloor: (): undefined => undefined,
    idle: true,
    leafId: "leaf1" as string | null,
    busy: false,
    script: "idle" as "idle" | "running",
    branch: [] as Array<{ id: string; parentId: string | null; user: boolean; preview: string }>,
    ownSessions: ["sess-1", "sess-2"],
  };
  const counters = { captures: 0, active: 0, maxActive: 0, restores: 0, diskChecks: 0, snapshots: 0 };

  const kernel: CheckpointKernel = {
    refs: async () => new Map(refs),
    async capture(_git, _root, _gitDir, _indexDir, ref) {
      counters.captures += 1;
      const n = counters.captures;
      counters.active += 1;
      counters.maxActive = Math.max(counters.maxActive, counters.active);
      log.push(`capture-start ${ref.slice(ref.indexOf(LANE_ID) + LANE_ID.length + 1)}`);
      try {
        await behaviour.capture();
      } finally {
        counters.active -= 1;
      }
      log.push(`capture-end ${n}`);
      return { commit: oid(n), tree: behaviour.tree(n), skipped: behaviour.skipped, left: behaviour.left };
    },
    async restore(_git, _root, _gitDir, commit, undo) {
      counters.restores += 1;
      log.push(`restore ${commit} undo=${undo.commit}`);
      return behaviour.restore();
    },
    async snapshot() {
      counters.snapshots += 1;
      return { tree: behaviour.tree(0), skipped: 0, left: [] };
    },
  };

  const git = {
    async run(_root: string, args: readonly string[]) {
      if (args[0] === "update-ref") {
        const deleting = args.includes("-d");
        const ref = (deleting ? args[3] : args[2]) as string;
        if (deleting) refs.delete(ref);
        else refs.set(ref, args[3] as string);
        log.push(`${deleting ? "delete-ref" : "update-ref"} ${ref.split(`${LANE_ID}/`)[1]}`);
        return { stdout: Buffer.alloc(0), code: 0 };
      }
      if (args[0] === "rev-parse") {
        const commit = (args.at(-1) as string).replace("^{tree}", "");
        return { stdout: Buffer.from(`${behaviour.treeOfCommit(commit)}\n`), code: 0 };
      }
      throw new Error(`unexpected git ${args.join(" ")}`);
    },
  } as unknown as GitRunner;

  const sessions = {
    runState: vi.fn(() => ({ idle: behaviour.idle, leafId: behaviour.leafId })),
    activityIn: vi.fn(() => ({ sessions: 1, busy: behaviour.busy, needsInput: false })),
    sessionIdsIn: vi.fn(() => behaviour.ownSessions),
    branchPath: vi.fn(async () => ({ leafId: behaviour.leafId, entries: behaviour.branch })),
  };
  const store = {
    get: (id: string) => (id === LANE_ID ? lane : undefined),
    getOwned: (ownerId: string, id: string) => (ownerId === "u1" && id === LANE_ID ? lane : undefined),
    markFirstRunEnded: vi.fn<(id: string, at: number) => void>(),
  };
  const shared = {
    store,
    git,
    kernel,
    indexDir: "/home/tmp/git-index",
    gitDirOf: (worktree: string) => (worktree === WORKTREE ? GIT_DIR : undefined),
    lock: locks.laneLock,
    notices,
    clock,
    logger: silentLogger,
    readOnly: over.readOnly ?? false,
    diskFloor: (path: string): undefined => {
      counters.diskChecks += 1;
      log.push(`disk ${path}`);
      behaviour.diskFloor();
      return undefined;
    },
    refreshFacts: vi.fn(async (laneId: string) => void log.push(`facts ${laneId}`)),
    publish: vi.fn((laneId: string) => void log.push(`publish ${laneId}`)),
    sessions: () => sessions as never,
  };
  const checkpoints = createCheckpoints({
    ...shared,
    paths: { laneOf: (cwd: string) => (cwd.startsWith(WORKTREE) ? lane : null) },
  } satisfies CheckpointDeps);
  const restorer = createRestorer({
    ...shared,
    scripts: { state: () => ({ state: behaviour.script }) as never },
  } satisfies RestoreDeps);

  const info = (over: Partial<LaneRunInfo> = {}): LaneRunInfo => ({
    ownerId: "u1",
    sessionId: "sess-1",
    cwd: WORKTREE,
    leafId: "leaf1",
    ...over,
  });
  return {
    clock,
    log,
    refs,
    changed,
    notices,
    behaviour,
    counters,
    sessions,
    store,
    shared,
    checkpoints,
    restorer,
    info,
    lane,
  };
}
