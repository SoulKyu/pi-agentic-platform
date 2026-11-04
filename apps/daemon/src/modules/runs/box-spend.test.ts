import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "../sessions/index.ts";
import { createBoxSpend } from "./box-spend.ts";
import { createRunsModule, RUNS_MIGRATIONS, type RunsService } from "./index.ts";
import { assistantEnd } from "./testing/events.ts";

const HOUR = 3_600_000;
const ATLAS = "atlas-1a2b";
const BIRCH = "birch-3c4d";
let dir: string;
let db: Db;
let clock: FakeClock;
let service: RunsService;
let fromMs: number;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-box-spend-"));
  clock = createFakeClock(Date.UTC(2026, 9, 14, 12, 0, 0));
  const logger = createLogger({ level: "warn", clock, write: (line) => void expect.fail(line) });
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS, RUNS_MIGRATIONS],
    clock,
    logger,
  }).db;
  service = createRunsModule({ db, clock, logger, appendLine: () => {} });
  fromMs = Date.UTC(2026, 9, 14, 0, 0, 0);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function session(id: string, projectId: string | null): void {
  db.run(
    `INSERT INTO sessions (id, pi_path, pi_session_id, cwd, owner_id, name, project_id, created_at, updated_at, tool_preset)
     VALUES ($id, $piPath, $id, '/x', 'u1', NULL, $projectId, 1, 1, 'default')`,
    { id, piPath: `/p/${id}`, projectId },
  );
}

type How = {
  provider?: string;
  cost: number;
  agentId?: string;
  owner?: string;
  billing?: "api" | "subscription";
  live?: true;
};
function run(id: string, how: How): void {
  const who = { id, ownerId: how.owner ?? "u1", ...(how.agentId ? { agentId: how.agentId } : {}) };
  service.observer.onRecord(who, "run_start", { origin: "user" }, null);
  service.observer.onEvent(
    id,
    assistantEnd({ cost: how.cost }, how.provider ? { provider: how.provider } : {}),
  );
  if (how.live !== true)
    service.observer.onRecord(
      who,
      "run_end",
      { aborted: false },
      how.billing ? { billing: how.billing } : null,
    );
}
const spend = () => createBoxSpend({ db, clock });

describe("per-box spend today", () => {
  it("sums the agent's runs by agent and a project's runs through their session", () => {
    session("sp", "p1");
    run("r1", { cost: 0.1, agentId: ATLAS });
    run("r2", { cost: 0.2, agentId: ATLAS });
    run("sp", { cost: 0.05 });
    const today = spend().todayByBox("u1", fromMs, false);
    expect(today.agents.get(ATLAS)).toBeCloseTo(0.3, 10);
    expect(today.projects.get("p1")).toBeCloseTo(0.05, 10);
    expect(today.agents.size).toBe(1);
    expect(today.projects.size).toBe(1);
  });

  it("counts a run with neither link in the total only", () => {
    session("sp", "p1");
    run("r1", { cost: 0.1, agentId: ATLAS });
    run("sp", { cost: 0.05 });
    run("loose", { cost: 1 });
    expect(spend().todayByBox("u1", fromMs, false).totalUsd).toBeCloseTo(1.15, 10);
  });

  it("skips a run that ended before the day and counts a running one", async () => {
    run("old", { cost: 5, agentId: ATLAS });
    await clock.advance(HOUR);
    run("live", { cost: 2, agentId: ATLAS, live: true });
    const today = spend().todayByBox("u1", clock.now() - HOUR / 2, false);
    expect(today.agents.get(ATLAS)).toBe(2);
    expect(today.totalUsd).toBe(2);
  });

  it("apiOnly drops a subscription run; without it the subscription flag is set", () => {
    run("r1", { cost: 1, agentId: ATLAS, billing: "api" });
    run("r2", { cost: 4, agentId: ATLAS, billing: "subscription" });
    const all = spend().todayByBox("u1", fromMs, false);
    expect(all.agents.get(ATLAS)).toBe(5);
    expect(all.subscription).toBe(true);
    const api = spend().todayByBox("u1", fromMs, true);
    expect(api.agents.get(ATLAS)).toBe(1);
    expect(api.totalUsd).toBe(1);
    expect(api.subscription).toBe(false);
  });

  it("names the boxes that have a subscription run, not the ones billed by API", () => {
    session("sub-session", "p-sub");
    session("api-session", "p-api");
    run("sub-session", { cost: 2, billing: "subscription" });
    run("api-session", { cost: 3, billing: "api" });
    run("a1", { cost: 1, agentId: ATLAS, billing: "subscription" });
    run("a2", { cost: 1, agentId: BIRCH, billing: "api" });
    const today = spend().todayByBox("u1", fromMs, false);
    expect([...today.subscriptionProjects]).toEqual(["p-sub"]);
    expect([...today.subscriptionAgents]).toEqual([ATLAS]);
  });

  it("apiOnly leaves out a run through the Claude bridge, the member line's own rule", () => {
    run("r1", { cost: 1, agentId: ATLAS });
    run("r2", { cost: 3, agentId: ATLAS, provider: "claude-bridge", live: true });
    expect(spend().todayByBox("u1", fromMs, false).totalUsd).toBe(4);
    expect(spend().todayByBox("u1", fromMs, true).totalUsd).toBe(1);
  });

  it("counts a run of an agent's session once, for the agent, even when the session has a project", () => {
    session("thread", "p1");
    run("thread", { cost: 2, agentId: ATLAS });
    const today = spend().todayByBox("u1", fromMs, false);
    expect(today.agents.get(ATLAS)).toBe(2);
    expect(today.projects.size).toBe(0);
    expect(today.totalUsd).toBe(2);
  });

  it("leaves another owner's runs out", () => {
    run("r1", { cost: 1, agentId: ATLAS });
    run("r2", { cost: 7, agentId: BIRCH, owner: "u2" });
    const today = spend().todayByBox("u1", fromMs, false);
    expect([...today.agents.keys()]).toEqual([ATLAS]);
    expect(today.totalUsd).toBe(1);
  });

  it("reports an empty day as zero", () => {
    expect(spend().todayByBox("u1", fromMs, false)).toEqual({
      agents: new Map(),
      projects: new Map(),
      totalUsd: 0,
      subscription: false,
      subscriptionAgents: new Set(),
      subscriptionProjects: new Set(),
    });
  });
});

describe("live runs", () => {
  it("maps a session to the start of its running run, the owner's only", async () => {
    run("done", { cost: 1 });
    await clock.advance(HOUR);
    const startedAt = clock.now();
    run("live", { cost: 1, live: true });
    run("other", { cost: 1, owner: "u2", live: true });
    expect(spend().liveRuns("u1")).toEqual(new Map([["live", startedAt]]));
  });
});
