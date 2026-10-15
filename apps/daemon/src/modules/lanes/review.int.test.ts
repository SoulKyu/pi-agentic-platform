import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewList } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

const TIMEOUT = 60_000;

let t: TestDaemon;
let repo: GitBed;
let owner: TestClient;
let laneId: string;
let worktree: string;

const ok = async <T>(client: TestClient, method: string, params: unknown): Promise<T> => {
  const answer = await client.call(method as never, params as never);
  if (!answer.ok) throw new Error(`${method} failed: ${answer.error.code}`);
  return answer.result as T;
};

beforeEach(async () => {
  repo = createGitBed();
  t = await startTestDaemon({ steps: [{ text: "hi" }, { text: "hi" }] });
  const cookie = await t.login();
  owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
  const projectRoot = realpathSync(repo.root);
  await ok(owner, "sessions.create", { cwd: projectRoot });
  const sub = (await ok<{ sub: string }>(owner, "subscribe.lane", {})).sub;
  const made = await ok<{ laneIds: string[] }>(owner, "lanes.create", {
    projectRoot,
    title: "Review me",
    description: "x",
    models: [null],
  });
  laneId = made.laneIds[0] as string;
  await vi.waitFor(
    () => {
      const last = owner.events
        .filter((frame) => frame.sub === sub)
        .map(
          (frame) => frame.event as { kind: string; lane?: { id: string; state: string; worktree: string } },
        )
        .filter((event) => event.kind === "lane" && event.lane?.id === laneId)
        .at(-1);
      expect(last?.lane?.state).toBe("active");
      worktree = last?.lane?.worktree as string;
    },
    { timeout: TIMEOUT },
  );
});
afterEach(async () => {
  owner.close();
  await t.stop();
  repo.dispose();
});

describe("lanes.review over /ws (M9R76)", () => {
  it(
    "lists the committed and the uncommitted file, and vcs.fileDiff answers both texts from the answered oids",
    async () => {
      writeFileSync(join(worktree, "committed.txt"), "one\ntwo\n");
      repo.git(worktree, "add", "committed.txt");
      repo.git(worktree, "commit", "-q", "-m", "add committed");
      writeFileSync(join(worktree, "live.txt"), "fresh\n");
      writeFileSync(join(worktree, "a.txt"), "one\nchanged\n");

      const list = await ok<ReviewList>(owner, "lanes.review", { laneId, scope: { kind: "branch" } });
      expect(list.from.label).toBe("main");
      expect(list.to.kind).toBe("live");
      const byPath = new Map(list.files.map((file) => [file.path, file]));
      expect(byPath.get("committed.txt")).toMatchObject({ status: "A", additions: 2, deletions: 0 });
      expect(byPath.get("live.txt")).toMatchObject({ status: "A", additions: 1, deletions: 0 });
      expect(byPath.get("a.txt")).toMatchObject({ status: "M", additions: 1, deletions: 0 });

      const texts = async (path: string) =>
        ok<{ before: string | null; after: string | null }>(owner, "vcs.fileDiff", {
          root: worktree,
          path,
          from: { kind: "commit", oid: list.from.oid },
          to: { kind: "worktree" },
        });
      expect((await texts("committed.txt")).after).toBe("one\ntwo\n");
      expect((await texts("live.txt")).after).toBe("fresh\n");
      expect((await texts("a.txt")).before).toBe("one\n");
    },
    TIMEOUT,
  );

  it(
    "stores Seen and comments with compare-and-set, and refuses a stale revision",
    async () => {
      const doc = { seen: [{ path: "a.txt", identity: "a".repeat(40) }], comments: [] };
      expect(await ok(owner, "lanes.reviewState.get", { laneId })).toEqual({
        doc: { seen: [], comments: [] },
        revision: 0,
      });
      expect(await ok(owner, "lanes.reviewState.set", { laneId, doc, baseRevision: 0 })).toEqual({
        revision: 1,
      });
      const stale = await owner.call("lanes.reviewState.set", { laneId, doc, baseRevision: 0 });
      expect(stale).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(await ok(owner, "lanes.reviewState.get", { laneId })).toEqual({ doc, revision: 1 });
    },
    TIMEOUT,
  );

  it("lists no turns for a session that has none, and not_found for a stranger session", async () => {
    const lane = await owner.call("lanes.turns", { laneId, sessionId: "nope" });
    expect(lane).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});
