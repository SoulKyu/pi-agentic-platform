import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDenySet } from "../../kernel/fs/deny-set.ts";
import { createBoundaryBed } from "../../kernel/testing/boundary-bed.ts";
import { createRealBed, type RealBed } from "../worktrees/testing/real.ts";
import { createLaneConfig, createLanesService } from "./index.ts";
import { scriptHash } from "./project-config.ts";
import { insertLane } from "./testing/lane-rows.ts";
import { createFakes, runnerOf } from "./testing/script-fakes.ts";

const MARKER = "archive-marker";
const ARCHIVE = `echo ran > "$PAP_LANE_ROOT/${MARKER}"`;
const SETUP = "echo setup";

let bed: RealBed;
beforeEach(() => {
  bed = createRealBed();
  const { root } = bed.repo;
  mkdirSync(join(root, ".pi"), { recursive: true });
  writeFileSync(join(root, ".pi", "project.yaml"), `setup: ${SETUP}\narchive: ${ARCHIVE}\n`);
  for (const [kind, text] of [
    ["setup", SETUP],
    ["archive", ARCHIVE],
  ] as const)
    bed.worktrees.db.run(
      `INSERT INTO lane_script_approvals (owner_id, project_root, kind, sha256, script, approved_at)
       VALUES ('u1', $root, $kind, $sha, $text, 1)`,
      { root, kind, sha: scriptHash(text), text },
    );
});
afterEach(() => bed.dispose());

const compose = (readOnly = false) => {
  const bb = createBoundaryBed();
  const deny = createDenySet(bb.denySources(), bed.worktrees.clock);
  const worktrees = bed.module({ readOnly });
  const config = createLaneConfig({
    db: bed.worktrees.db,
    git: bed.git,
    clock: bed.worktrees.clock,
    logger: bed.worktrees.logger,
    boundary: bb.config(),
    deny,
    roots: () => [bed.repo.root],
    audit: { append: () => {} },
    readOnly,
  });
  const fakes = createFakes();
  const service = createLanesService({
    db: bed.worktrees.db,
    git: bed.git,
    clock: bed.worktrees.clock,
    logger: bed.worktrees.logger,
    home: bed.worktrees.papHome,
    worktrees,
    config,
    scripts: runnerOf({
      db: bed.worktrees.db,
      clock: bed.worktrees.clock,
      logger: bed.worktrees.logger,
      home: bed.worktrees.papHome,
      fakes,
      approved: config.approvedScript,
    }),
    terminals: { runningIn: () => 0 },
    boundary: bb.config(),
    deny,
    denyFolders: [],
    readOnly,
  });
  // The daemon recovers before the sessions and policy ports exist, and binds after: so does this bed.
  const bind = () =>
    service.bind({
      sessions: { releaseIn: () => ({ released: 0, busy: 0 }), archiveIn: () => 0 } as never,
      trust: { clear: async () => {}, status: async () => null, inherit: async () => false },
      policy: {
        sessionPolicy: () => ({ taint: { tainted: false, epoch: 0 } }) as never,
        markTainted: () => false,
      },
      hub: { publish: () => {}, registerSnapshot: () => {} },
    });
  return { service, fakes, bind, dispose: () => bb.dispose() };
};

const LANE = "recover-1a2b";
/** A lane row for `id` over a worktree that really exists (phase 2 done by hand). */
async function realLane(id: string, state: string) {
  const module = bed.module();
  const path = bed.reserve(module, id);
  await module.create(path);
  await module.ready(path);
  const lane = insertLane(bed.worktrees.db, { id, worktree: path, projectRoot: bed.repo.root });
  bed.worktrees.db.run("UPDATE lanes SET state = $state, branch = $branch WHERE id = $id", {
    id,
    state,
    branch: `pap/${id}`,
  });
  return { ...lane, path };
}
const row = (id: string) =>
  bed.worktrees.db.get<{
    state: string;
    failed_reason: string | null;
    setup_state: string;
    archived_at: number | null;
  }>("SELECT state, failed_reason, setup_state, archived_at FROM lanes WHERE id = $id", { id });

describe("lane recovery at boot (M9R41)", () => {
  it("finishes a lane left archiving without running its archive script again", async () => {
    const lane = await realLane(LANE, "archiving");
    expect(existsSync(lane.path)).toBe(true);
    const { service, bind, dispose } = compose();
    await service.recover();
    // Nothing is resumed before the ports are bound (the daemon's order), and the lane waits.
    expect(row(LANE)?.state).toBe("archiving");
    expect(existsSync(lane.path)).toBe(true);
    bind();
    await vi.waitFor(() => expect(row(LANE)?.state).toBe("archived"), { timeout: 20_000 });
    expect(existsSync(lane.path)).toBe(false);
    expect(row(LANE)?.archived_at).not.toBeNull();
    expect(existsSync(join(bed.repo.root, MARKER))).toBe(false);
    expect(bed.repo.git(bed.repo.root, "worktree", "list")).not.toContain(LANE);
    await service.shutdown();
    dispose();
  }, 40_000);

  it("fails a lane left creating without a worktree row (interrupted)", async () => {
    insertLane(bed.worktrees.db, { id: "lost-0001", worktree: bed.worktrees.folder("lost-0001") });
    const { service, bind, dispose } = compose();
    await service.recover();
    bind();
    expect(row("lost-0001")).toMatchObject({ state: "failed", failed_reason: "interrupted" });
    await service.shutdown();
    dispose();
  });

  it("activates a lane left creating with a ready worktree, its setup interrupted when one was due", async () => {
    await realLane("kept-0001", "creating");
    const { service, bind, dispose } = compose();
    await service.recover();
    bind();
    expect(row("kept-0001")).toMatchObject({
      state: "active",
      failed_reason: null,
      setup_state: "interrupted",
    });
    await service.shutdown();
    dispose();
  });

  it("leaves setup none when the project has no setup script", async () => {
    await realLane("plain-0001", "creating");
    bed.worktrees.db.run("DELETE FROM lane_script_approvals WHERE kind = 'setup'");
    writeFileSync(join(bed.repo.root, ".pi", "project.yaml"), `archive: ${ARCHIVE}\n`);
    const { service, bind, dispose } = compose();
    await service.recover();
    bind();
    expect(row("plain-0001")).toMatchObject({ state: "active", setup_state: "none" });
    await service.shutdown();
    dispose();
  });

  it("changes nothing on a read-only database and says so once", async () => {
    await realLane("kept-0002", "creating");
    await realLane("arch-0002", "archiving");
    insertLane(bed.worktrees.db, { id: "lost-0002", worktree: bed.worktrees.folder("lost-0002") });
    const { service, bind, dispose } = compose(true);
    await service.recover();
    bind();
    expect(row("kept-0002")?.state).toBe("creating");
    expect(row("arch-0002")?.state).toBe("archiving");
    expect(row("lost-0002")?.state).toBe("creating");
    expect(bed.worktrees.logged("lane_recovery_skipped")).toHaveLength(1);
    await service.shutdown();
    dispose();
  });
});
