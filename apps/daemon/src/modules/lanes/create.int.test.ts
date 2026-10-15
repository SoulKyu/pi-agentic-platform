import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EventFrame, LaneView } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGitBed, type GitBed } from "../../kernel/testing/git-bed.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import type { TestClient } from "../../testing/ws-client.ts";
import { scriptHash } from "./project-config.ts";

const SETUP = "echo ready > ready.txt";
const TIMEOUT = 60_000;

let t: TestDaemon;
let repo: GitBed;
let owner: TestClient;
let projectRoot: string;
let laneSub: string;

beforeEach(async () => {
  repo = createGitBed();
  t = await startTestDaemon({ steps: [{ text: "hi" }, { text: "hi" }, { text: "hi" }] });
  const cookie = await t.login();
  owner = await t.connect(cookie);
  await t.confirmStepUp(cookie);
  projectRoot = realpathSync(repo.root);
  // A session in the folder makes the project (the owner's project roots come from the sessions' folders).
  const made = await owner.call("sessions.create", { cwd: projectRoot });
  if (!made.ok) throw new Error(`sessions.create failed: ${made.error.code}`);
  // The project file sits in the main checkout; the lane never needs it.
  mkdirSync(join(projectRoot, ".pi"), { recursive: true });
  writeFileSync(join(projectRoot, ".pi", "project.yaml"), `setup: ${SETUP}\n`);
  const approved = await owner.call("lanes.approveScripts", {
    projectRoot,
    scripts: [{ kind: "setup", sha256: scriptHash(SETUP) }],
  });
  expect(approved).toMatchObject({ ok: true, result: { ok: true } });
  const opened = await owner.call("subscribe.lane", {});
  if (!opened.ok) throw new Error("subscribe.lane failed");
  laneSub = (opened.result as { sub: string }).sub;
});
afterEach(async () => {
  owner.close();
  await t.stop();
  repo.dispose();
});

const laneEvents = (client: TestClient, sub: string, laneId: string): LaneView[] =>
  client.events
    .filter((frame: EventFrame) => frame.sub === sub)
    .map((frame) => frame.event as { kind: string; lane?: LaneView })
    .filter((event) => event.kind === "lane" && event.lane?.id === laneId)
    .map((event) => event.lane as LaneView);

const createLane = async (client: TestClient, title: string, description: string): Promise<string> => {
  const answer = await client.call("lanes.create", {
    projectRoot,
    title,
    description,
    models: [null],
  });
  if (!answer.ok) throw new Error(`lanes.create failed: ${answer.error.code}`);
  const result = answer.result as { laneIds: string[]; fanoutId: string | null };
  expect(result.fanoutId).toBeNull();
  return result.laneIds[0] as string;
};

const piFilesWith = (text: string): string[] =>
  readdirSync(join(t.root, "agent"), { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => join(t.root, "agent", name))
    .filter((file) => readFileSync(file, "utf8").includes(text));

describe("lanes.create over /ws", () => {
  it(
    "answers a lane id, shows creating then active with the setup running then ok, and starts the session in the worktree",
    async () => {
      const id = await createLane(owner, "Add thing", "do it");
      await vi.waitFor(
        () => {
          const last = laneEvents(owner, laneSub, id).at(-1);
          expect(last).toMatchObject({ state: "active", setup: { state: "ok", exitCode: 0 } });
          expect(last?.primarySessionId).not.toBeNull();
        },
        { timeout: TIMEOUT },
      );
      const views = laneEvents(owner, laneSub, id);
      expect(views[0]?.state).toBe("creating");
      const setupStates = views.map((view) => view.setup.state);
      expect(setupStates.indexOf("running")).toBeGreaterThanOrEqual(0);
      expect(setupStates.indexOf("ok")).toBeGreaterThan(setupStates.indexOf("running"));
      const last = views.at(-1) as LaneView;
      expect(last.worktree.startsWith(join(t.home, "worktrees"))).toBe(true);
      expect(existsSync(join(last.worktree, "ready.txt"))).toBe(true);
      expect(last.createdBy).toBe("session");

      // The first user message of the primary session (the transcript is written by Pi).
      await vi.waitFor(() => expect(piFilesWith("Add thing")).toHaveLength(1), { timeout: TIMEOUT });
      const lines = readFileSync(piFilesWith("Add thing")[0] as string, "utf8")
        .trim()
        .split("\n");
      const firstUser = lines
        .map((line) => JSON.parse(line) as { type?: string; message?: { role?: string; content?: unknown } })
        .find((entry) => entry.type === "message" && entry.message?.role === "user");
      expect(JSON.stringify(firstUser?.message?.content)).toContain("# Add thing\\n\\ndo it");

      // The lane's session is filed under the project of the main checkout (the scope alias), not under a project of its own.
      const opened = await owner.call("subscribe.shell", {});
      const shellSub = (opened as unknown as { result: { sub: string } }).result.sub;
      const frame = await owner.waitForEvent(
        (event) => event.sub === shellSub && (event.event as { kind?: string }).kind === "snapshot",
        10_000,
      );
      const shell = frame.event as {
        sessions: Array<{ id: string; cwd: string; projectId: string | null }>;
        projects: Array<{ id: string; root: string }>;
      };
      const inLane = shell.sessions.find((session) => session.id === last.primarySessionId);
      expect(inLane?.cwd).toBe(last.worktree);
      expect(shell.projects.find((project) => project.id === inLane?.projectId)?.root).toBe(projectRoot);
      expect(shell.projects.filter((project) => project.root === last.worktree)).toEqual([]);
      // The worktree is a file root of the owner.
      expect(await owner.call("files.list", { path: last.worktree })).toMatchObject({
        ok: true,
        result: { entries: expect.arrayContaining([expect.objectContaining({ name: "ready.txt" })]) },
      });
      expect(await owner.call("subscribe.vcs", { root: last.worktree })).toMatchObject({ ok: true });
    },
    TIMEOUT * 2,
  );

  it(
    "keeps the setup of a token-created lane pending: nothing runs and no session starts",
    async () => {
      const minted = await owner.call("auth.tokens.create", {
        name: "ci",
        permissions: ["lanes:read", "lanes:operate"],
        expiresInDays: 7,
      });
      if (!minted.ok) throw new Error("token create failed");
      const bot = await t.connectBearer((minted.result as { value: string }).value);
      try {
        const id = await createLane(bot, "From a token", "do it too");
        await vi.waitFor(
          () => {
            const view = laneEvents(owner, laneSub, id).at(-1);
            expect(view).toMatchObject({ state: "active", createdBy: "token", setup: { state: "pending" } });
          },
          { timeout: TIMEOUT },
        );
        const view = laneEvents(owner, laneSub, id).at(-1) as LaneView;
        expect(view.primarySessionId).toBeNull();
        expect(existsSync(join(view.worktree, "ready.txt"))).toBe(false);
        expect(laneEvents(owner, laneSub, id).some((v) => v.setup.state === "running")).toBe(false);
      } finally {
        bot.close();
      }
    },
    TIMEOUT * 2,
  );

  it("answers not_found for a folder that is not one of the owner's projects", async () => {
    const answer = await owner.call("lanes.create", {
      projectRoot: join(projectRoot, ".pi"),
      title: "Nope",
      description: "x",
      models: [null],
    });
    expect(answer).toMatchObject({ ok: false, error: { code: "not_found" } });
    const preview = await owner.call("lanes.preview", { projectRoot: join(projectRoot, ".pi") });
    expect(preview).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("the lane stream snapshot", () => {
  it("starts with the owner's lanes and the archived count", async () => {
    const second = await owner.call("subscribe.lane", {});
    if (!second.ok) throw new Error("subscribe failed");
    const sub = (second.result as { sub: string }).sub;
    const first = await owner.waitForEvent((frame) => frame.sub === sub, 10_000);
    expect(first.event).toMatchObject({ kind: "snapshot", lanes: [], fanouts: [], archived: 0 });
  });
});
