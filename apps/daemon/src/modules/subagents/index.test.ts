import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createSubagentsModule, SUBAGENTS_MIGRATIONS, type SubagentsModuleDeps } from "./index.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(readOnly = false) {
  const dir = mkdtempSync(join(tmpdir(), "pap-subagents-module-"));
  dirs.push(dir);
  const clock = createFakeClock(5_000);
  const db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, SUBAGENTS_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  for (const [id, state] of [
    ["r1", "starting"],
    ["r2", "running"],
  ] as const)
    db.run(
      `INSERT INTO subagent_runs (id, owner_id, parent_session_id, title, state, started_at) VALUES ($id, 'u1', 'p1', 'T', $state, 1)`,
      { id, state },
    );
  db.run(
    "INSERT INTO subagent_runs (id, owner_id, parent_session_id, title, state, started_at, ended_at) VALUES ('r3', 'u1', 'p1', 'T', 'done', 1, 2)",
  );
  const sessions = {
    cwdOf: vi.fn(() => null),
    kindOf: vi.fn(() => null),
    child: {
      admits: vi.fn(() => true),
      createChildSession: vi.fn(),
      lastText: vi.fn(),
      setSource: vi.fn(),
      refresh: vi.fn(),
      onGone: vi.fn(() => () => undefined),
      waitingAgent: vi.fn(() => false),
      parentOpen: vi.fn(() => true),
    },
    automation: {
      prompt: vi.fn(),
      abort: vi.fn(async () => undefined),
      releaseIdle: vi.fn(() => "released"),
    },
  };
  const deps = {
    ports: { pi: { helpers: { run: vi.fn() }, trust: { status: async () => true } }, sessions },
    db,
    clock,
    logger: silentLogger,
    readOnly,
    newId: () => "id",
    settings: { subagents: () => ({ enabled: true, maxConcurrent: 2 }) },
    runs: {
      onRunEnd: vi.fn(() => () => undefined),
      expectOrigin: vi.fn(() => true),
      clearExpected: vi.fn(),
      openTaskOf: vi.fn(),
      sessionCost: vi.fn(() => 0.25),
    },
    agents: { over: () => false },
  } as unknown as SubagentsModuleDeps;
  const state = (id: string) =>
    db.get<{ state: string; reason: string | null; ended_at: number | null }>(
      "SELECT state, reason, ended_at FROM subagent_runs WHERE id = $id",
      { id },
    );
  return { deps, state, db, sessions };
}

describe("the subagents module at boot (M11R139 e)", () => {
  it("marks the children a stopped daemon left running interrupted, and leaves the ended ones", () => {
    const { deps, state } = open();
    createSubagentsModule(deps);
    expect(state("r1")).toEqual({ state: "interrupted", reason: "restart", ended_at: 5_000 });
    expect(state("r2")).toEqual({ state: "interrupted", reason: "restart", ended_at: 5_000 });
    expect(state("r3")).toEqual({ state: "done", reason: null, ended_at: 2 });
  });

  it("writes nothing on a read-only database", () => {
    const { deps, state } = open(true);
    createSubagentsModule(deps);
    expect(state("r1")?.state).toBe("starting");
  });

  it("hands the platform port the op and the owner's switch", () => {
    const { deps } = open();
    const module = createSubagentsModule(deps);
    expect(typeof module.op).toBe("function");
    expect(module.enabled("u1")).toBe(true);
    expect(Object.keys(module.rpc)).toEqual(["subagents.profiles", "subagents.cancel"]);
    expect(() => module.stop()).not.toThrow();
  });
});

describe("the subagents module's wiring (M11R139, M11R140)", () => {
  it("watches the parents' run ends and their archive or deletion, for the stop", () => {
    const { deps, sessions } = open();
    createSubagentsModule(deps);
    expect(deps.runs.onRunEnd).toHaveBeenCalledTimes(1);
    expect(sessions.child.onGone).toHaveBeenCalledTimes(1);
  });

  it("gives the sessions module the children of a parent, newest first, with each child's cost", () => {
    const { deps, sessions, db } = open();
    createSubagentsModule(deps);
    db.run("UPDATE subagent_runs SET child_session_id = 'c-' || id WHERE id IN ('r2', 'r3')");
    db.run("UPDATE subagent_runs SET started_at = 10 WHERE id = 'r2'");
    const [source] = sessions.child.setSource.mock.calls[0] as [
      { childrenOf(ownerId: string, parentId: string, limit: number): unknown[] },
    ];
    expect(source.childrenOf("u1", "p1", 8)).toEqual([
      { id: "c-r2", runId: "r2", title: "T", profile: null, state: "interrupted", costUsd: 0.25 },
      { id: "c-r3", runId: "r3", title: "T", profile: null, state: "done", costUsd: 0.25 },
    ]);
    expect(deps.runs.sessionCost).toHaveBeenCalledWith("c-r2");
    expect(source.childrenOf("u2", "p1", 8)).toEqual([]);
  });

  it("answers whether an agent has a child waiting from the sessions module", () => {
    const { deps, sessions } = open();
    const module = createSubagentsModule(deps);
    sessions.child.waitingAgent.mockReturnValueOnce(true);
    expect(module.childWaiting("u1", "atlas-1a2b")).toBe(true);
    expect(sessions.child.waitingAgent).toHaveBeenCalledWith("u1", "atlas-1a2b");
    expect(module.childWaiting("u1", "atlas-1a2b")).toBe(false);
  });

  it("stops no child for an agent that has none", () => {
    const { deps } = open();
    expect(createSubagentsModule(deps).cancelAgent("u1", "atlas-1a2b")).toBe(0);
  });
});

describe("the prompt's hand-off (review I2)", () => {
  it("reaches the sessions module with a stillWanted that turns false once the call is stopped", async () => {
    const { deps, sessions } = open();
    sessions.child.createChildSession.mockResolvedValue({ sessionId: "c1", tainted: false });
    sessions.automation.prompt.mockResolvedValue("handled");
    const controller = new AbortController();
    const module = createSubagentsModule(deps);
    const call = module.op(
      { task: "look" },
      {
        ownerId: "u1",
        sessionId: "p9",
        type: "plain",
        tainted: false,
        agentId: null,
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(sessions.automation.prompt).toHaveBeenCalledTimes(1));
    expect(sessions.automation.prompt).toHaveBeenCalledWith(
      expect.objectContaining({ ownerId: "u1", sessionId: "c1", stillWanted: expect.any(Function) }),
    );
    const { stillWanted } = sessions.automation.prompt.mock.calls[0]?.[0] as { stillWanted: () => boolean };
    expect(stillWanted()).toBe(true);
    controller.abort();
    expect(stillWanted()).toBe(false);
    await expect(call).rejects.toMatchObject({ code: "cancelled" });
  });
});

describe("subagents.cancel (M11R153)", () => {
  const input = (signal: AbortSignal) => ({
    ownerId: "u1",
    sessionId: "p9",
    type: "plain" as const,
    tainted: false,
    agentId: null,
    signal,
  });
  const ctx = (userId: string) => ({ caller: { userId } }) as never;

  it("stops the running child of that run, for its owner", async () => {
    const { deps, sessions, state } = open();
    sessions.child.createChildSession.mockResolvedValue({ sessionId: "c1", tainted: false });
    sessions.automation.prompt.mockResolvedValue("handled");
    const module = createSubagentsModule(deps);
    const call = module.op({ task: "look" }, input(new AbortController().signal));
    await vi.waitFor(() => expect(sessions.automation.prompt).toHaveBeenCalledTimes(1));
    await expect(module.rpc["subagents.cancel"]({ runId: "id" }, ctx("u2"))).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(module.rpc["subagents.cancel"]({ runId: "id" }, ctx("u1"))).resolves.toEqual({ ok: true });
    await expect(call).rejects.toMatchObject({ code: "cancelled" });
    expect(state("id")).toMatchObject({ state: "cancelled", reason: "stopped" });
    expect(sessions.automation.abort).toHaveBeenCalledWith("u1", "c1");
  });

  it("answers not_found for a run that is not running", async () => {
    const { deps } = open();
    const module = createSubagentsModule(deps);
    await expect(module.rpc["subagents.cancel"]({ runId: "r3" }, ctx("u1"))).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
