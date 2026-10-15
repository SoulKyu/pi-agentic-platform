import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventFrame, LaneView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";

const TIMEOUT = 60_000;
const STEPS = Array.from({ length: 6 }, () => ({ text: "ok" }));

let t: TestDaemon;
let repo: GitBed;
let owner: TestClient;
let cookie: string;
let projectRoot: string;
let laneSub: string;

beforeEach(async () => {
  repo = createGitBed();
  t = await startTestDaemon({ steps: STEPS });
  cookie = await t.login();
  owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
  projectRoot = realpathSync(repo.root);
  // A prompt template needs a trust decision and runs nothing; it is part of every commit below.
  mkdirSync(join(projectRoot, ".pi", "prompts"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "prompts", "hello.md"), "hello\n");
  repo.git(projectRoot, "add", ".");
  repo.git(projectRoot, "commit", "-q", "-m", "prompt template");
  // A local branch outside the checkout's lineage: a lane cut from it does not inherit trust (M9R83).
  repo.git(projectRoot, "switch", "-q", "-c", "feat-x");
  writeFileSync(join(projectRoot, "x.txt"), "x\n");
  repo.git(projectRoot, "add", "x.txt");
  repo.git(projectRoot, "commit", "-q", "-m", "unmerged work");
  repo.git(projectRoot, "switch", "-q", "main");
  const made = await owner.call("sessions.create", { cwd: projectRoot });
  if (!made.ok) throw new Error(`sessions.create failed: ${made.error.code}`);
  const opened = await owner.call("subscribe.lane", {});
  if (!opened.ok) throw new Error("subscribe.lane failed");
  laneSub = (opened.result as { sub: string }).sub;
});
afterEach(async () => {
  owner.close();
  await t.stop();
  repo.dispose();
});

const trustFile = () => join(t.root, "agent", "trust.json");
const trusted = (): Record<string, boolean> =>
  existsSync(trustFile()) ? (JSON.parse(readFileSync(trustFile(), "utf8")) as Record<string, boolean>) : {};
const lastView = (id: string): LaneView | undefined =>
  owner.events
    .filter((frame: EventFrame) => frame.sub === laneSub)
    .map((frame) => frame.event as { kind: string; lane?: LaneView })
    .filter((event) => event.kind === "lane" && event.lane?.id === id)
    .at(-1)?.lane;

async function newLane(title: string, baseRef?: string): Promise<LaneView> {
  const answer = await owner.call("lanes.create", {
    projectRoot,
    title,
    description: "x",
    models: [null],
    ...(baseRef ? { baseRef } : {}),
  });
  if (!answer.ok) throw new Error(`lanes.create failed: ${answer.error.code}`);
  const id = (answer.result as { laneIds: string[] }).laneIds[0] as string;
  await vi.waitFor(
    () => {
      expect(lastView(id)?.state).toBe("active");
      expect(lastView(id)?.primarySessionId).not.toBeNull();
    },
    { timeout: TIMEOUT },
  );
  return lastView(id) as LaneView;
}

const archiveWhenIdle = async (laneId: string) => {
  let last: { ok: boolean; reason?: string } = { ok: false };
  await vi.waitFor(
    async () => {
      const answer = await owner.call("lanes.archive", { laneId, force: false, deleteBranch: false });
      if (!answer.ok) throw new Error(`lanes.archive failed: ${answer.error.code}`);
      last = answer.result as typeof last;
      expect(last.reason).not.toBe("busy");
    },
    { timeout: TIMEOUT },
  );
  return last;
};

describe("trust and lanes, with the real Pi helper (final review I1, I2)", () => {
  it(
    "the banner of a lane cut from an unmerged branch can ask: status answers, trust.set works with a step-up, a reopened worker is trusted",
    async () => {
      expect(await owner.call("trust.set", { cwd: projectRoot, decision: true })).toMatchObject({ ok: true });
      const lane = await newLane("From a branch", "refs/heads/feat-x");
      // Not in the checkout's lineage: nothing was inherited.
      expect(trusted()[lane.worktree]).toBeUndefined();

      expect(await owner.call("trust.status", { cwd: lane.worktree })).toMatchObject({
        ok: true,
        result: { decision: null, requiresTrust: true },
      });
      // A step-up is still needed to trust the folder.
      await t.confirmStepUp(cookie);
      const sessionId = lane.primarySessionId as string;
      const sub = ((await owner.call("subscribe.session", { sessionId })) as { result: { sub: string } })
        .result.sub;
      const mark = owner.events.at(-1)?.seq ?? 0;
      expect(await owner.call("trust.set", { cwd: lane.worktree, decision: true })).toMatchObject({
        ok: true,
        result: { ok: true },
      });
      expect(trusted()[lane.worktree]).toBe(true);
      await owner.waitForEvent(
        (f) => f.sub === sub && f.seq > mark && (f.event as { status?: string }).status === "cold",
        30_000,
      );
      // The next worker of the lane reads the decision.
      await owner.call("sessions.prompt", { sessionId, text: "go" });
      const reopened = await owner.waitForEvent(
        (f) =>
          f.sub === sub &&
          f.seq > mark &&
          (f.event as { kind?: string }).kind === "loadout" &&
          (f.event as { loadout?: { projectTrust?: unknown } | null }).loadout?.projectTrust !== undefined,
        30_000,
      );
      expect((reopened.event as { loadout: { projectTrust: unknown } }).loadout.projectTrust).toEqual({
        required: true,
        trusted: true,
      });
    },
    TIMEOUT * 2,
  );

  it(
    "archive clears the lane's trust entry from Pi's trust.json while the folder still exists, and audits it",
    async () => {
      expect(await owner.call("trust.set", { cwd: projectRoot, decision: true })).toMatchObject({ ok: true });
      const lane = await newLane("Inherits");
      // Cut from the checkout's HEAD with the same `.pi`: the lane inherited the project's decision.
      expect(trusted()[lane.worktree]).toBe(true);

      expect(await archiveWhenIdle(lane.id)).toMatchObject({ ok: true });

      expect(existsSync(lane.worktree)).toBe(false);
      expect(Object.keys(trusted())).not.toContain(lane.worktree);
      expect(trusted()[projectRoot]).toBe(true);
      const audit = (await owner.call("audit.list", {})) as {
        result: { entries: Array<{ reason: string | null; detail: unknown }> };
      };
      expect(audit.result.entries.find((row) => row.reason === "project_trust_cleared")?.detail).toEqual({
        folder: lane.worktree,
      });
    },
    TIMEOUT * 2,
  );
});
