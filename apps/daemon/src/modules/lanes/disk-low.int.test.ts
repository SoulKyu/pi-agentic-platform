import { existsSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { rows } from "../../security/testing/automation-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

const TIMEOUT = 60_000;
/** More than any disk has free: the floor of `PAP_MIN_FREE_DISK_MB` is crossed on every filesystem. */
const HUGE_FLOOR_MB = 2 ** 40;

let t: TestDaemon;
let repo: GitBed;
let owner: TestClient;

beforeEach(async () => {
  repo = createGitBed();
  t = await startTestDaemon({ steps: [{ text: "hi" }] }, { config: { minFreeDiskMb: HUGE_FLOOR_MB } });
  const cookie = await t.login();
  owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
});
afterEach(async () => {
  owner.close();
  await t.stop();
  repo.dispose();
});

describe("the disk floor on the lane paths (M10 on M9, R1)", () => {
  it(
    "answers disk_low (not capacity) to lanes.create below PAP_MIN_FREE_DISK_MB, and writes no lane",
    async () => {
      const projectRoot = realpathSync(repo.root);
      const made = await owner.call("sessions.create", { cwd: projectRoot });
      expect(made.ok).toBe(true);
      const answer = await owner.call("lanes.create", {
        projectRoot,
        title: "Add thing",
        description: "do it",
        models: [null],
      });
      expect(answer).toMatchObject({ ok: false, error: { code: "disk_low" } });
      // The refusal comes before anything is written: no lane, no worktree row, no folder under $PAP_HOME/worktrees.
      expect(rows(t.home, "SELECT id FROM lanes")).toEqual([]);
      expect(rows(t.home, "SELECT path FROM worktrees")).toEqual([]);
      const folder = join(t.home, "worktrees");
      expect(existsSync(folder) ? readdirSync(folder) : []).toEqual([]);
    },
    TIMEOUT,
  );
});
