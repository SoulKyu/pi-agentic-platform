import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneView, MethodName, ParamsOf } from "@pap/contracts";
import { type Db, openDatabase } from "../../kernel/db/database.ts";
import type { OutwardBed } from "../../modules/lanes/testing/outward-bed.ts";
import type { TestClient } from "../../testing/ws-client.ts";

export const TIMEOUT = 120_000;
export const ISSUE_URL = "https://github.com/test/repo/issues/7";

/** The answer of a call that must have succeeded. */
export async function ok<T>(client: TestClient, method: MethodName, params: unknown): Promise<T> {
  const answer = await client.call(method, params as ParamsOf<typeof method>);
  if (!answer.ok) throw new Error(`${method} failed: ${answer.error.code}`);
  return answer.result as T;
}

/** `.pi/project.yaml` of the bed's project, the main checkout. */
export function writeProjectConfig(bed: OutwardBed, text: string): void {
  mkdirSync(join(bed.projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(bed.projectRoot, ".pi", "project.yaml"), text);
}

/** The owner's approval of the scripts in the project file as it is now. */
export async function approve(
  bed: OutwardBed,
  scripts: ReadonlyArray<{ kind: "setup" | "test"; sha256: string }>,
): Promise<void> {
  const answer = await ok<{ ok: boolean }>(bed.owner, "lanes.approveScripts", {
    projectRoot: bed.projectRoot,
    scripts,
  });
  if (!answer.ok) throw new Error("approval refused");
}

export const latest = (bed: OutwardBed, laneId: string): LaneView | undefined => bed.views(laneId).at(-1);

/** `lanes.create` through `client`, answered with the lane ids once the rows exist. */
export async function createLaneAs(
  client: TestClient,
  bed: OutwardBed,
  over: Record<string, unknown> = {},
): Promise<string[]> {
  const answer = await client.call("lanes.create", {
    projectRoot: bed.projectRoot,
    title: "Add thing",
    description: "do it",
    models: [null],
    ...over,
  } as ParamsOf<"lanes.create">);
  if (!answer.ok) throw new Error(`lanes.create failed: ${answer.error.code}`);
  return (answer.result as { laneIds: string[] }).laneIds;
}

/** The setup log of a lane as the owner reads it. */
export async function setupLog(bed: OutwardBed, laneId: string): Promise<string> {
  const chunk = await ok<{ text: string }>(bed.owner, "lanes.scriptLog", {
    laneId,
    kind: "setup",
    offset: 0,
  });
  return chunk.text;
}

/** Pi's session files (under the bed's agent folder) that hold `text`. */
export function piFilesWith(bed: OutwardBed, text: string): string[] {
  const agent = join(bed.t.root, "agent");
  return readdirSync(agent, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(agent, name))
    .filter((file) => readFileSync(file, "utf8").includes(text));
}

/** The provider script the next worker reads when it starts (a worker reads it once, at its start). */
export function rewriteScript(bed: OutwardBed, steps: readonly object[]): void {
  writeFileSync(join(bed.t.root, "script.json"), JSON.stringify({ steps }));
}

export const GHOST = "ghost-owner";
export interface Ghost {
  readonly laneId: string;
  readonly secondLaneId: string;
  readonly archivedLaneId: string;
  readonly fanoutId: string;
  readonly sessionId: string;
  readonly projectRoot: string;
  /** The ghost's lane folder; it holds `secret.txt`. */
  readonly worktree: string;
}

/**
 * v1 has one owner, so "another owner" is a set of rows with an owner id no connection can hold: two lanes in a
 * fan-out group, an archived lane, a session and a project, with real folders under `$PAP_HOME`.
 */
export function seedGhost(bed: OutwardBed, db: Db): Ghost {
  const ghost: Ghost = {
    laneId: "ghost-lane-1a2b",
    secondLaneId: "ghost-two-1a2c",
    archivedLaneId: "ghost-old-1a2d",
    fanoutId: "0123456789abcdef",
    sessionId: "ghost-session-1",
    projectRoot: join(bed.repo.dir, "ghost-repo"),
    worktree: join(bed.t.home, "worktrees", "ghost-lane-1a2b"),
  };
  bed.repo.initRepo(ghost.projectRoot);
  // A real lane worktree with its `worktrees` row and git dir: a git-backed method that finds the lane must go on to use
  // them, so only the owner check can answer `not_found`.
  const baseOid = bed.repo.git(ghost.projectRoot, "rev-parse", "HEAD").trim();
  bed.repo.git(ghost.projectRoot, "worktree", "add", "-q", "-b", `pi/${ghost.laneId}`, ghost.worktree);
  writeFileSync(join(ghost.worktree, "secret.txt"), "SECRET_TEXT_of_another_owner\n");
  const now = Date.now();
  db.run(
    `INSERT INTO worktrees (path, owner_id, repo_root, branch, git_dir, base_oid, created_branch, state, created_at, updated_at)
     VALUES ($path, $owner, $root, $branch, $gitDir, $oid, 1, 'ready', $now, $now)`,
    {
      path: ghost.worktree,
      owner: GHOST,
      root: ghost.projectRoot,
      branch: `pi/${ghost.laneId}`,
      gitDir: join(ghost.projectRoot, ".git", "worktrees", ghost.laneId),
      oid: baseOid,
      now,
    },
  );
  db.run(
    "INSERT INTO projects (id, owner_id, root, name, position, created_at) VALUES ('ghost-project', $owner, $root, 'ghost', 1, $now)",
    { owner: GHOST, root: ghost.projectRoot, now },
  );
  db.run(
    "INSERT INTO sessions (id, cwd, owner_id, created_at, updated_at) VALUES ($id, $cwd, $owner, $now, $now)",
    { id: ghost.sessionId, cwd: ghost.worktree, owner: GHOST, now },
  );
  db.run("INSERT INTO lane_fanouts (id, owner_id, prompt, created_at) VALUES ($id, $owner, 'p', $now)", {
    id: ghost.fanoutId,
    owner: GHOST,
    now,
  });
  const lane = (id: string, over: { state: string; slot: number | null; archivedAt: number | null }) => {
    const worktree = id === ghost.laneId ? ghost.worktree : join(bed.t.home, "worktrees", id);
    if (id !== ghost.laneId) mkdirSync(worktree, { recursive: true });
    db.run(
      `INSERT INTO lanes (id, owner_id, created_by, project_root, worktree, branch, base_ref, base_oid, title, description,
         primary_session_id, fanout_id, fanout_slot, state, archived_at, created_at)
       VALUES ($id, $owner, 'session', $root, $worktree, $branch, 'main', $oid, 'ghost', '', $session, $fanout, $slot, $state, $archivedAt, $now)`,
      {
        id,
        owner: GHOST,
        root: ghost.projectRoot,
        worktree,
        branch: `pi/${id}`,
        oid: baseOid,
        session: id === ghost.laneId ? ghost.sessionId : null,
        fanout: over.slot === null ? null : ghost.fanoutId,
        slot: over.slot,
        state: over.state,
        archivedAt: over.archivedAt,
        now,
      },
    );
  };
  lane(ghost.laneId, { state: "active", slot: 0, archivedAt: null });
  lane(ghost.secondLaneId, { state: "active", slot: 1, archivedAt: null });
  lane(ghost.archivedLaneId, { state: "archived", slot: null, archivedAt: now });
  return ghost;
}

/** The daemon's database, through a second connection of this test. */
export const openStateDb = (bed: OutwardBed): Db => openDatabase(join(bed.t.home, "state.db"));

/** A session of the ghost owner whose folder lies inside `cwd`: only the owner filter can keep it out of the caller's lane. */
export function seedGhostSessionIn(db: Db, cwd: string): string {
  const id = "ghost-session-inside";
  const now = Date.now();
  db.run(
    "INSERT INTO sessions (id, cwd, owner_id, created_at, updated_at) VALUES ($id, $cwd, $owner, $now, $now)",
    { id, cwd, owner: GHOST, now },
  );
  return id;
}
