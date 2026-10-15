import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

const TIMEOUT = 60_000;
const REPLY = { text: "```\nfix: scripted message\n\nBody.\n```" };

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
  t = await startTestDaemon({
    // Whichever call reaches the provider first, the answer is the same: the lane's first prompt may or may not have run.
    steps: [REPLY, REPLY, REPLY],
  });
  const cookie = await t.login();
  owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
  const projectRoot = realpathSync(repo.root);
  await ok(owner, "sessions.create", { cwd: projectRoot });
  const sub = (await ok<{ sub: string }>(owner, "subscribe.lane", {})).sub;
  const made = await ok<{ laneIds: string[] }>(owner, "lanes.create", {
    projectRoot,
    title: "Suggest me",
    description: "x",
    models: [null],
  });
  laneId = made.laneIds[0] as string;
  await vi.waitFor(
    () => {
      const last = owner.events
        .filter((frame) => frame.sub === sub)
        .map(
          (frame) =>
            frame.event as {
              kind: string;
              lane?: { id: string; state: string; worktree: string; primarySessionId: string | null };
            },
        )
        .filter((event) => event.kind === "lane" && event.lane?.id === laneId)
        .at(-1);
      expect(last?.lane?.state).toBe("active");
      expect(last?.lane?.primarySessionId).not.toBeNull();
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

describe("lanes.suggestCommit over /ws (M9R79, M9R80)", () => {
  it(
    "answers the scripted model's message, unfenced, for the selected path",
    async () => {
      writeFileSync(join(worktree, "live.txt"), "fresh\n");
      const answer = await ok<{ ok: boolean; message?: string }>(owner, "lanes.suggestCommit", {
        laneId,
        paths: ["live.txt"],
      });
      expect(answer).toEqual({ ok: true, message: "fix: scripted message\n\nBody." });
    },
    TIMEOUT,
  );

  it(
    "answers nothing for a path with no change, without a model call",
    async () => {
      const answer = await ok<{ ok: boolean; reason?: string }>(owner, "lanes.suggestCommit", {
        laneId,
        paths: ["a.txt"],
      });
      expect(answer).toEqual({ ok: false, reason: "nothing" });
    },
    TIMEOUT,
  );
});
