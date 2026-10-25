import { realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composeLanes, type LanesComposeDeps } from "./compose-lanes.ts";
import { boundaryConfigOf, denySourcesOf } from "./compose-workspace.ts";
import { createFakeClock } from "./kernel/clock.ts";
import { silentLogger } from "./kernel/logger.ts";
import { testCaller } from "./testing/caller.ts";
import type { Config } from "./kernel/config.ts";
import { createWorktreesBed, type WorktreesBed } from "./modules/worktrees/testing/bed.ts";
import type { LanesServiceDeps } from "./modules/lanes/index.ts";
import type { createWorktreesModule, WorktreesPort } from "./modules/worktrees/index.ts";
import { insertLane } from "./modules/lanes/testing/lane-rows.ts";

const unusedGit = { run: () => Promise.reject(new Error("unused")) };

let bed: WorktreesBed;
beforeEach(() => {
  bed = createWorktreesBed();
});
afterEach(() => bed.dispose());

const workspace = () => ({
  git: unusedGit,
  boundary: boundaryConfigOf(
    { home: bed.papHome, piAgentDir: join(bed.dir, "agent"), userHome: bed.dir } as Config,
    {},
  ),
  deny: {} as never,
  home: bed.papHome,
  runningIn: () => 0,
  runtime: { scopes: { next: () => null }, env: {}, umask: 0o022 },
});

describe("composeLanes", () => {
  it("answers recover() within its 60 s budget when the worktrees module never settles, and logs it", async () => {
    const worktrees = { recover: () => new Promise<void>(() => {}) } as unknown as WorktreesPort;
    const lanes = composeLanes({
      isMember: () => false,
      db: bed.db,
      wk: workspace(),
      audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
      roots: () => [],
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      config: { minFreeDiskMb: 0 },
      worktrees,
    });
    let settled = false;
    const done = lanes.recover().then(() => (settled = true));
    await bed.clock.advance(59_000);
    expect(settled).toBe(false);
    await bed.clock.advance(1_001);
    await done;
    expect(bed.logged("worktree_recovery_timeout")).toHaveLength(1);
  });

  it("recovers a failing module without throwing: the boot goes on", async () => {
    const worktrees = { recover: () => Promise.reject(new Error("boom")) } as unknown as WorktreesPort;
    const lanes = composeLanes({
      isMember: () => false,
      db: bed.db,
      wk: workspace(),
      audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
      roots: () => [],
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      config: { minFreeDiskMb: 0 },
      worktrees,
    });
    await expect(lanes.recover()).resolves.toBeUndefined();
    expect(bed.logged("worktree_recovery_failed")).toHaveLength(1);
  });

  it("starts with no lane roots, scopes or closed lanes: its paths answer from the store", () => {
    const lanes = composeLanes({
      isMember: () => false,
      db: bed.db,
      wk: workspace(),
      audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
      roots: () => [],
      clock: createFakeClock(),
      logger: silentLogger,
      readOnly: false,
      config: { minFreeDiskMb: 0 },
    });
    expect(lanes.paths.roots("o1")).toEqual([]);
    expect(lanes.paths.scopeOf("s1")).toBeNull();
    expect(lanes.paths.closed("s1")).toBeNull();
  });
});

describe("composeLanes bind and recovery", () => {
  const build = (worktrees: Partial<WorktreesPort> = { recover: async () => {} }) =>
    composeLanes({
      isMember: () => false,
      db: bed.db,
      wk: workspace(),
      audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
      roots: () => [],
      clock: bed.clock,
      logger: bed.logger,
      readOnly: false,
      config: { minFreeDiskMb: 0 },
      worktrees: worktrees as WorktreesPort,
    });
  const lane = (id: string, state: string) => {
    insertLane(bed.db, { id, worktree: bed.folder(id) });
    bed.db.run("UPDATE lanes SET state = $state, archived_at = 1 WHERE id = $id", { id, state });
  };

  it("rebuilds the paths from the store at construction: an archived lane's folder is closed", () => {
    lane("gone-0001", "archived");
    expect(build().paths.closed(bed.folder("gone-0001"))).toBe("archived");
  });

  it("sets the lane hooks on bind: synchronous no-ops with work to do nowhere, closed from the paths", () => {
    lane("gone-0001", "archived");
    const lanes = build();
    const setLaneHooks = vi.fn();
    const registered: string[] = [];
    lanes.bind({
      sessions: { lanes: {} as never, setLaneHooks },
      pi: { trust: {} as never, useLaneRoots: () => {} },
      policy: {} as never,
      hub: { publish: () => {}, registerSnapshot: (name) => void registered.push(name) },
    });
    expect(registered).toEqual(["lane"]);
    expect(setLaneHooks).toHaveBeenCalledTimes(1);
    const hooks = setLaneHooks.mock.calls[0]?.[0];
    expect(hooks.closed(bed.folder("gone-0001"))).toBe("archived");
    expect(hooks.closed(bed.folder("other-0001"))).toBeNull();
    // Never `async () => {}`: a promise would make the prompt yield and break the busy rule (M2R88).
    expect(hooks.holdsFiles("/x")).toBeNull();
    // A session of another owner in this owner's lane is refused; the owner's own is not (Task 8's carry).
    expect(() => hooks.assertOwn("u2", `${bed.folder("gone-0001")}/src`)).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => hooks.assertOwn("u1", bed.folder("gone-0001"))).not.toThrow();
    expect(() => hooks.assertOwn("u2", "/elsewhere")).not.toThrow();
    // A session outside any lane: the checkpoint hooks have nothing to do and answer at once (Task 15).
    const outside = { ownerId: "u1", sessionId: "s", cwd: "/elsewhere", leafId: null };
    expect(hooks.beforePrompt(outside, { value: false })).toBeUndefined();
    expect(hooks.afterRun(outside)).toBeUndefined();
  });

  it("fails a lane a crash left creating without a ready worktree (interrupted), and activates one whose worktree is ready", async () => {
    lane("lost-0001", "creating");
    lane("kept-0001", "creating");
    lane("live-0001", "active");
    const lanes = build({
      recover: async () => {},
      byPath: (path: string) =>
        path === bed.folder("kept-0001") ? ({ state: "ready" } as never) : undefined,
    });
    await lanes.recover();
    const state = (id: string) =>
      bed.db.get<{ state: string; failed_reason: string | null }>(
        "SELECT state, failed_reason FROM lanes WHERE id = $id",
        { id },
      );
    expect(state("lost-0001")).toEqual({ state: "failed", failed_reason: "interrupted" });
    expect(state("kept-0001")).toEqual({ state: "active", failed_reason: null });
    expect(state("live-0001")).toEqual({ state: "active", failed_reason: null });
    expect(lanes.paths.roots("u1")).toEqual([bed.folder("kept-0001"), bed.folder("live-0001")]);
  });

  it("joins its closers at shutdown", async () => {
    await expect(build().shutdown()).resolves.toBeUndefined();
  });
});

describe("composeLanes rpc", () => {
  it("serves lanes.preview and lanes.approveScripts (not_found for a stranger's folder), and no lanes method answers internal any more", async () => {
    const lanes = composeLanes({
      isMember: () => false,
      db: bed.db,
      wk: workspace(),
      audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
      roots: () => [],
      clock: createFakeClock(),
      logger: silentLogger,
      readOnly: false,
      config: { minFreeDiskMb: 0 },
    });
    const ctx = { caller: testCaller() } as never;
    await expect(lanes.rpc["lanes.preview"]({ projectRoot: "/x" }, ctx)).rejects.toMatchObject({
      code: "not_found",
    });
    // lanes.compare is served (Task 18b): a fan-out that is not there is not_found, not internal.
    await expect(lanes.rpc["lanes.compare"]({ fanoutId: "0123456789abcdef" }, ctx)).rejects.toMatchObject({
      code: "not_found",
    });
    // lanes.turns is served (Task 16): a lane that is not there is not_found.
    await expect(
      lanes.rpc["lanes.turns"]({ laneId: "lane-0001", sessionId: "s1" }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
    // lanes.listArchived is served (Task 6b): nothing archived yet.
    await expect(lanes.rpc["lanes.listArchived"]({}, ctx)).resolves.toEqual({ lanes: [], hasMore: false });
    // lanes.scriptLog is served (Task 5): a lane that is not there is not_found, not internal.
    await expect(
      lanes.rpc["lanes.scriptLog"]({ laneId: "lane-0001", kind: "setup", offset: 0 }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("composeLanes outward operations (Task 14)", () => {
  const build = (wk: Partial<ReturnType<typeof workspace>> & { remoteProtocols?: string } = {}) =>
    composeLanes({
      isMember: () => false,
      db: bed.db,
      wk: { ...workspace(), ...wk },
      audit: { port: { append: () => {}, reserve: () => true, fromWorker: () => null } },
      roots: () => [],
      clock: createFakeClock(),
      logger: silentLogger,
      readOnly: false,
      config: { minFreeDiskMb: 0 },
    });

  it("serves commit, push, prCreate and prRefresh: a lane that is not there is not_found, not internal", async () => {
    const lanes = build();
    const ctx = { caller: testCaller() } as never;
    const gone = { laneId: "nope-0001" };
    await expect(lanes.rpc["lanes.push"](gone, ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(lanes.rpc["lanes.prRefresh"](gone, ctx)).rejects.toMatchObject({ code: "not_found" });
    await expect(
      lanes.rpc["lanes.prCreate"]({ ...gone, title: "t", body: "", draft: false }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      lanes.rpc["lanes.commit"]({ ...gone, paths: ["a"], message: "m" }, ctx),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("makes the forge folder $PAP_HOME/tmp/forge, 0700, at its real path", () => {
    build();
    const dir = join(bed.papHome, "tmp", "forge");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(realpathSync(dir)).toBe(dir);
  });
});

describe("the boundary opens pap's worktrees folder (M9R21)", () => {
  it("has papHomeOpen = [worktrees], and the deny sources skip $PAP_HOME/worktrees", () => {
    const home = join(bed.dir, "pap");
    const config = { home, piAgentDir: join(bed.dir, "agent"), userHome: bed.dir } as Config;
    const boundary = boundaryConfigOf(config, {});
    expect(boundary.papHomeOpen).toEqual(["worktrees"]);
    expect(denySourcesOf(boundary).skip).toContain(join(home, "worktrees"));
  });
});

describe("the disk-floor seam (final review M14)", () => {
  // M10's `diskFloor(path, floorMb)` answers `{ ok }`: a seam that accepted it would never refuse. Each declaration
  // site must fail to compile with it (the `@ts-expect-error` below turns into an error when a site is loosened).
  const checker = () => ({ ok: true });
  const guard = (): undefined => undefined;

  it("accepts a function that returns nothing and refuses one that returns a result, at every declaration site", () => {
    const sites: Array<LanesComposeDeps["diskFloor"] | LanesServiceDeps["diskFloor"]> = [guard];
    // @ts-expect-error the composition seam returns undefined, not { ok }
    const compose: LanesComposeDeps["diskFloor"] = checker;
    // @ts-expect-error the lanes service seam returns undefined, not { ok }
    const service: LanesServiceDeps["diskFloor"] = checker;
    // @ts-expect-error the worktrees seam returns undefined, not { ok }
    const worktrees: Parameters<typeof createWorktreesModule>[0]["diskFloor"] = checker;
    expect(sites).toHaveLength(1);
    expect([compose, service, worktrees]).toHaveLength(3);
  });
});
