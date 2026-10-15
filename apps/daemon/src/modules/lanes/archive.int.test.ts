import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaneView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";
import { scriptHash } from "./project-config.ts";

const ARCHIVE = 'echo done > "$PAP_LANE_ROOT/archive-marker"';
const TIMEOUT = 60_000;

interface AuditRow {
  reason: string | null;
  detail: unknown;
}

let t: TestDaemon;
let repo: GitBed;
let owner: TestClient;
let projectRoot: string;

beforeEach(async () => {
  repo = createGitBed();
  t = await startTestDaemon({ steps: [{ text: "hi" }, { text: "hi" }, { text: "hi" }, { text: "hi" }] });
  const cookie = await t.login();
  owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
  projectRoot = repo.root;
  const made = await owner.call("sessions.create", { cwd: projectRoot });
  if (!made.ok) throw new Error(`sessions.create failed: ${made.error.code}`);
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "project.yaml"), `archive: ${ARCHIVE}\n`);
  const approved = await owner.call("lanes.approveScripts", {
    projectRoot,
    scripts: [{ kind: "archive", sha256: scriptHash(ARCHIVE) }],
  });
  expect(approved).toMatchObject({ ok: true, result: { ok: true } });
});
afterEach(async () => {
  owner.close();
  await t.stop();
  repo.dispose();
});

async function newLane(title: string): Promise<{ id: string; sessionId: string; lane: LaneView }> {
  // One subscription, opened before the create: a retry that subscribes again hits the 64-per-socket cap on a slow start.
  const opened = await owner.call("subscribe.lane", {});
  if (!opened.ok) throw new Error(`subscribe.lane failed: ${opened.error.code}`);
  const sub = (opened.result as { sub: string }).sub;
  const answer = await owner.call("lanes.create", { projectRoot, title, description: "x", models: [null] });
  if (!answer.ok) throw new Error(`lanes.create failed: ${answer.error.code}`);
  const id = (answer.result as { laneIds: string[] }).laneIds[0] as string;
  // The lane's primary session runs its first turn; archive says busy until it is idle.
  let lane!: LaneView;
  await vi.waitFor(
    () => {
      lane = owner.events
        .filter((frame) => frame.sub === sub)
        .map((frame) => frame.event as { kind: string; lane?: LaneView })
        .filter((event) => event.kind === "lane" && event.lane?.id === id)
        .at(-1)?.lane as LaneView;
      expect(lane?.state).toBe("active");
      expect(lane.primarySessionId).not.toBeNull();
    },
    { timeout: TIMEOUT },
  );
  await owner.call("unsubscribe", { sub });
  return { id, sessionId: lane.primarySessionId as string, lane };
}

const archive = async (laneId: string, over: Record<string, unknown> = {}) => {
  const answer = await owner.call("lanes.archive", { laneId, force: false, deleteBranch: false, ...over });
  if (!answer.ok) throw new Error(`lanes.archive failed: ${answer.error.code}`);
  return answer.result as { ok: boolean; reason?: string; branchDeleted?: boolean | null };
};
/** Archive refuses `busy` while the first turn runs and changes nothing; asked again until it is not. */
const archiveWhenIdle = async (laneId: string, over: Record<string, unknown> = {}) => {
  let last: Awaited<ReturnType<typeof archive>> | undefined;
  await vi.waitFor(
    async () => {
      last = await archive(laneId, over);
      expect(last.reason).not.toBe("busy");
    },
    { timeout: TIMEOUT },
  );
  return last as Awaited<ReturnType<typeof archive>>;
};
const branches = () => repo.git(projectRoot, "branch", "--format=%(refname:short)");
const refs = () => repo.git(projectRoot, "for-each-ref", "--format=%(refname)", "refs/pap/checkpoints");

describe("lanes.archive over /ws", () => {
  it(
    "archives a lane with two checkpoint refs and an approved script: worktree, refs and logs gone, branch kept, worker released",
    async () => {
      const { id, sessionId, lane } = await newLane("Archive me");
      const head = repo.git(projectRoot, "rev-parse", "HEAD").trim();
      repo.git(projectRoot, "update-ref", `refs/pap/checkpoints/${id}/root`, head);
      repo.git(projectRoot, "update-ref", `refs/pap/checkpoints/${id}/undo`, head);
      // The first turn may add its own checkpoints meanwhile: the two planted refs are there, whatever else is.
      expect(refs().trim().split("\n")).toEqual(
        expect.arrayContaining([`refs/pap/checkpoints/${id}/root`, `refs/pap/checkpoints/${id}/undo`]),
      );
      // The lane has run no script, so a log is planted in its folder for the archive to delete.
      mkdirSync(join(t.home, "lanes", id), { recursive: true });
      writeFileSync(join(t.home, "lanes", id, "setup.log"), "line\n");

      expect(await archiveWhenIdle(id)).toEqual({ ok: true, branchDeleted: null });

      expect(existsSync(lane.worktree)).toBe(false);
      expect(refs().trim()).toBe("");
      expect(existsSync(join(t.home, "lanes", id))).toBe(false);
      expect(readFileSync(join(projectRoot, "archive-marker"), "utf8")).toBe("done\n");
      expect(branches()).toContain(lane.branch);
      expect(t.daemon.inspect.workerPid(sessionId)).toBeUndefined();
      const listed = await owner.call("lanes.listArchived", {});
      expect(listed).toMatchObject({
        ok: true,
        result: { lanes: [expect.objectContaining({ id, state: "archived" })] },
      });
      // A session of the archived lane is filed as archived.
      const sessions = await owner.call("sessions.listArchived", {});
      expect(JSON.stringify(sessions)).toContain(sessionId);
    },
    TIMEOUT * 2,
  );

  it(
    "refuses a dirty lane before the archive script runs, then archives it with force",
    async () => {
      const { id, lane } = await newLane("Dirty one");
      writeFileSync(join(lane.worktree, "wip.txt"), "unsaved\n");
      const refused = await archiveWhenIdle(id);
      expect(refused).toMatchObject({ ok: false, reason: "dirty" });
      expect(existsSync(join(projectRoot, "archive-marker"))).toBe(false);
      expect(existsSync(lane.worktree)).toBe(true);
      const rowsBefore = (await owner.call("audit.list", {})) as { result: { entries: AuditRow[] } };
      expect(rowsBefore.result.entries.some((row) => row.reason === "lane_archived_forced")).toBe(false);
      expect(await archive(id, { force: true })).toEqual({ ok: true, branchDeleted: null });
      expect(existsSync(lane.worktree)).toBe(false);
      // A forced archive destroys uncommitted work: it leaves a row with the lane, no paths (M13).
      const rows = (await owner.call("audit.list", {})) as { result: { entries: AuditRow[] } };
      expect(rows.result.entries.find((row) => row.reason === "lane_archived_forced")?.detail).toEqual({
        laneId: id,
        deleteBranch: false,
        branchDeleted: null,
      });
    },
    TIMEOUT * 2,
  );

  it(
    "deletes the branch when asked",
    async () => {
      const { id, lane } = await newLane("Drop branch");
      expect(await archiveWhenIdle(id, { deleteBranch: true })).toEqual({ ok: true, branchDeleted: true });
      expect(branches()).not.toContain(lane.branch);
    },
    TIMEOUT * 2,
  );

  it(
    "refuses a prompt in a lane being archived, and removes the worktree only after the script",
    async () => {
      const SLOW = `i=0; while [ ! -f "$PAP_LANE_ROOT/release" ] && [ -d "$PAP_LANE_ROOT" ] && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done; echo done > "$PAP_LANE_ROOT/archive-marker"`;
      writeFileSync(join(projectRoot, ".pi", "project.yaml"), `archive: ${SLOW}\n`);
      await owner.call("lanes.approveScripts", {
        projectRoot,
        scripts: [{ kind: "archive", sha256: scriptHash(SLOW) }],
      });
      const { id, sessionId, lane } = await newLane("Slow archive");
      // The first call that is not `busy` is the archive itself: it holds here until the script is released.
      let answer: Awaited<ReturnType<typeof archive>> | undefined;
      const pending = vi.waitFor(
        async () => {
          answer = await archive(id, { force: true });
          expect(answer.reason).not.toBe("busy");
        },
        { timeout: TIMEOUT, interval: 100 },
      );
      await vi.waitFor(
        async () => {
          const reply = await owner.call("sessions.prompt", { sessionId, text: "more" });
          expect(reply).toMatchObject({ ok: false, error: { code: "session_busy" } });
        },
        { timeout: TIMEOUT },
      );
      try {
        expect(existsSync(lane.worktree)).toBe(true);
      } finally {
        // Whatever the check says, the held script is let go before the folder is cleaned up.
        writeFileSync(join(projectRoot, "release"), "");
      }
      await pending;
      expect(answer).toEqual({ ok: true, branchDeleted: null });
      expect(existsSync(lane.worktree)).toBe(false);
    },
    TIMEOUT * 2,
  );
});
