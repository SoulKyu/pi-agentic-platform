import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deriveLaneStatus, type LaneView, type LanePreview, type ReviewList } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scriptHash } from "./project-config.ts";
import { type OutwardBed, startOutwardBed } from "./testing/outward-bed.ts";

const SETUP = "echo ready > ready.txt";
const FEATURE = "export const feature = 1;\n";
const WAIT = 60_000;
const TIMEOUT = 180_000;
const PR_URL = "https://github.com/test/repo/pull/7";
const PR_VIEW = JSON.stringify({
  number: 7,
  url: PR_URL,
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }],
});
/** The first run of the lane writes the feature file through a tool call, then says it is done. */
const STEPS = [
  { toolCalls: [{ name: "write", args: { path: "src/feature.ts", content: FEATURE }, id: "w1" }] },
  { text: "feature written" },
];

let bed: OutwardBed;
beforeEach(async () => {
  bed = await startOutwardBed(
    [{ stdout: "[]" }, { stdout: `${PR_URL}\n` }, { stdout: PR_VIEW }],
    {},
    { steps: STEPS },
  );
  // The fixture's .gitignore keeps the setup's output out of the lane's changes.
  writeFileSync(join(bed.projectRoot, ".gitignore"), "ready.txt\n");
  bed.repo.git(bed.projectRoot, "add", ".gitignore");
  bed.repo.git(bed.projectRoot, "commit", "-q", "-m", "ignore the setup output");
  mkdirSync(join(bed.projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(bed.projectRoot, ".pi", "project.yaml"), `setup: ${SETUP}\n`);
});
afterEach(() => bed.stop());

const ok = async <T>(method: string, params: unknown): Promise<T> => {
  const answer = await bed.owner.call(method as never, params as never);
  if (!answer.ok) throw new Error(`${method} failed: ${answer.error.code}`);
  return answer.result as T;
};
const lastView = (id: string): LaneView => bed.views(id).at(-1) as LaneView;

describe("the exit journey: lane, commit, push, pull request, restore, archive (M9 exit, daemon half)", () => {
  it(
    "walks a lane from the preview to the archive over /ws, with real git and a stubbed gh",
    async () => {
      // 1. The preview shows the approved scripts, the refs, the forge and the remote.
      const first = await ok<LanePreview>("lanes.preview", { projectRoot: bed.projectRoot });
      expect(first.config.scripts).toEqual([expect.objectContaining({ kind: "setup", approved: false })]);
      expect(
        await ok("lanes.approveScripts", {
          projectRoot: bed.projectRoot,
          scripts: [{ kind: "setup", sha256: scriptHash(SETUP) }],
        }),
      ).toEqual({ ok: true });
      const preview = await ok<LanePreview>("lanes.preview", { projectRoot: bed.projectRoot });
      expect(preview.config.scripts).toEqual([
        expect.objectContaining({ kind: "setup", text: SETUP, approved: true }),
      ]);
      expect(preview.refs.map((ref) => ref.ref)).toContain("refs/heads/main");
      expect(preview.forge).toBe("github");
      expect(preview.remote).toEqual({ host: "github.com", path: "test/repo" });

      // 2. lanes.create answers while the lane is creating; the stream goes creating, then active, with the setup ok.
      const created = await ok<{ laneIds: string[] }>("lanes.create", {
        projectRoot: bed.projectRoot,
        title: "Add feature",
        description: "write it",
        models: [null],
      });
      const id = created.laneIds[0] as string;
      // Waits for the lane to settle, then asserts: a failed lane or setup stops the wait at once.
      await vi.waitFor(
        () => {
          expect(lastView(id).state).not.toBe("creating");
          expect(["ok", "failed", "interrupted", "unapproved"]).toContain(lastView(id).setup.state);
          // The session starts once the setup is over.
          if (lastView(id).setup.state === "ok") expect(lastView(id).primarySessionId).not.toBeNull();
        },
        { timeout: WAIT },
      );
      expect(lastView(id)).toMatchObject({ state: "active", setup: { state: "ok" } });
      expect(bed.views(id)[0]?.state).toBe("creating");
      const lane = lastView(id);
      expect(existsSync(join(lane.worktree, "ready.txt"))).toBe(true);
      const sessionId = lane.primarySessionId as string;

      // 3. The scripted agent wrote the file with no dialog and the run ended: a checkpoint ref exists, one change is dirty.
      await vi.waitFor(() => expect(lastView(id).firstRunEndedAt).not.toBeNull(), { timeout: WAIT });
      // The transcript is read once the run has ended, so its first user row has an entry id.
      const sub = (await ok<{ sub: string }>("subscribe.session", { sessionId })).sub;
      const snapshot = await bed.owner.waitForEvent((frame) => frame.sub === sub);
      const rows = (snapshot.event as { rows: Array<{ entryId: string | null; message: { role?: string } }> })
        .rows;
      const firstUser = rows.find((row) => row.message.role === "user");
      expect(JSON.stringify(firstUser?.message)).toContain("# Add feature\\n\\nwrite it");
      expect(readFileSync(join(lane.worktree, "src", "feature.ts"), "utf8")).toBe(FEATURE);
      const checkpointRefs = bed.repo
        .git(bed.projectRoot, "for-each-ref", "--format=%(refname)", `refs/pap/checkpoints/${id}/`)
        .split("\n")
        .filter(Boolean);
      expect(checkpointRefs.some((ref) => ref.startsWith(`refs/pap/checkpoints/${id}/e/`))).toBe(true);
      await vi.waitFor(
        async () => {
          await ok("lanes.refresh", { laneId: id });
          expect(lastView(id).facts?.dirty).toBe(1);
        },
        { timeout: WAIT },
      );

      // 4. The review lists the file and vcs.fileDiff returns its text.
      const list = await ok<ReviewList>("lanes.review", { laneId: id, scope: { kind: "branch" } });
      expect(list.files.map((file) => file.path)).toEqual(["src/feature.ts"]);
      const diff = await ok<{ before: string | null; after: string | null }>("vcs.fileDiff", {
        root: lane.worktree,
        path: "src/feature.ts",
        from: { kind: "commit", oid: list.from.oid },
        to: { kind: "worktree" },
      });
      expect(diff.after).toBe(FEATURE);

      // 5. The commit carries the lane trailer.
      const committed = await ok<{ ok: true; oid: string }>("lanes.commit", {
        laneId: id,
        paths: ["src/feature.ts"],
        message: "Add the feature",
      });
      expect(committed.oid).toMatch(/^[0-9a-f]{40,64}$/);
      expect(bed.repo.git(lane.worktree, "log", "-1", "--format=%B").trim().endsWith(`Pap-Lane: ${id}`)).toBe(
        true,
      );

      // 6. The push goes to the rewritten remote.
      expect(lastView(id).pushRemote).toEqual({ host: "local", path: "remote.git" });
      expect(await ok("lanes.push", { laneId: id })).toMatchObject({ ok: true });
      expect(bed.repo.git(bed.bare, "rev-parse", `refs/heads/${lane.branch}`).trim()).toBe(committed.oid);

      // 7. The pull request is created with the exact argv; the lane is in review with both checks passing.
      const pr = await ok("lanes.prCreate", { laneId: id, title: "Add feature", body: "Body", draft: false });
      expect(pr).toMatchObject({ ok: true, pr: { number: 7, url: PR_URL, state: "open" } });
      const create = bed.stub.calls().find((call) => call.argv[1] === "create");
      expect(bed.stub.calls().map((call) => call.argv.slice(0, 2))).toEqual([
        ["pr", "list"],
        ["pr", "create"],
        ["pr", "view"],
      ]);
      expect(create?.stdin).toBe("Body");
      expect(create?.argv).toEqual([
        "pr",
        "create",
        "--repo=github.com/test/repo",
        `--head=${lane.branch}`,
        "--base=main",
        "--title=Add feature",
        "--body-file=-",
      ]);
      const shown = lastView(id);
      expect(shown.pr).toMatchObject({
        state: "open",
        checks: { total: 2, passed: 2, failed: 0, pending: 0 },
      });
      expect(deriveLaneStatus(shown, { busy: false, needsInput: false }).status).toBe("in_review");

      // 8. Back to the first user message: the files differ, the restore removes the committed file from the worktree.
      const target = firstUser?.entryId as string;
      expect(await ok("sessions.navigate", { sessionId, targetId: target })).toBeDefined();
      expect(await ok("lanes.checkpointStatus", { laneId: id, sessionId })).toMatchObject({ differs: true });
      expect(await ok("lanes.restore", { laneId: id, sessionId })).toMatchObject({ ok: true, changed: true });
      expect(existsSync(join(lane.worktree, "src", "feature.ts"))).toBe(false);
      // The commit still has it, so git sees a deletion.
      expect(bed.repo.git(lane.worktree, "status", "--porcelain").trim()).toBe("D src/feature.ts");
      expect(await ok("lanes.restore", { laneId: id, sessionId })).toMatchObject({
        ok: true,
        changed: false,
      });
      expect(await ok("lanes.restore", { laneId: id, undo: true })).toMatchObject({
        ok: true,
        changed: true,
      });
      expect(readFileSync(join(lane.worktree, "src", "feature.ts"), "utf8")).toBe(FEATURE);
      expect(bed.repo.git(lane.worktree, "status", "--porcelain").trim()).toBe("");

      // 9. The archive removes the worktree, the refs, the logs and the workers, and keeps the branch.
      let archived: { ok: boolean; reason?: string } = { ok: false };
      await vi.waitFor(
        async () => {
          archived = await ok("lanes.archive", { laneId: id, force: false, deleteBranch: false });
          expect(archived.reason).not.toBe("busy");
        },
        { timeout: WAIT },
      );
      expect(archived).toMatchObject({ ok: true });
      expect(existsSync(lane.worktree)).toBe(false);
      expect(
        bed.repo.git(bed.projectRoot, "for-each-ref", "--format=%(refname)", "refs/pap/checkpoints").trim(),
      ).toBe("");
      expect(existsSync(join(bed.t.home, "lanes", id))).toBe(false);
      expect(bed.t.daemon.inspect.workerPid(sessionId)).toBeUndefined();
      expect(bed.repo.git(bed.projectRoot, "branch", "--format=%(refname:short)")).toContain(lane.branch);
      expect(JSON.stringify(await ok("sessions.listArchived", {}))).toContain(sessionId);
      expect(await ok("lanes.listArchived", {})).toMatchObject({
        lanes: [expect.objectContaining({ id, state: "archived" })],
      });
    },
    TIMEOUT * 2,
  );
});
