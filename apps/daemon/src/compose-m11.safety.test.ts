import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDispatcher } from "./kernel/ws/dispatcher.ts";
import { silentLogger } from "./kernel/logger.ts";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

describe("quarantine, the permissions sheet and the prompt chips are wired (Task 21)", () => {
  const AGENT_ID = "atlas-0001";
  const insertAgent = (db: ReturnType<typeof parts>["db"]) =>
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
  const call = (caller = testCaller()) => ({ caller, openSubscription: vi.fn() }) as never;

  it("quarantines through agents.quarantine: the password first, then pause, cancel, archive and rotate in one command", async () => {
    const { m11, db, clock, automation, automationModule, sessions, home } = parts();
    insertAgent(db);
    mkdirSync(join(home, "agents", AGENT_ID), { recursive: true, mode: 0o700 });
    await m11.rpc["agents.openThread"]({ agentId: AGENT_ID }, call());
    automationModule.agentLink.cancelAllOf.mockResolvedValueOnce(2);
    automationModule.agentLink.rotateSecretsOf.mockReturnValueOnce({
      secrets: [{ triggerId: "t1", name: "Hook", secret: "pwh_x" }],
      failed: [],
    });
    await expect(m11.rpc["agents.quarantine"]({ agentId: AGENT_ID }, call())).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(m11.agents.get("u1", AGENT_ID)?.quarantinedAt).toBeNull();
    const owner = testCaller({ stepUpUntil: clock.now() + 60_000 });
    const answer = await m11.rpc["agents.quarantine"]({ agentId: AGENT_ID }, call(owner));
    expect(answer).toEqual({
      secrets: [{ triggerId: "t1", name: "Hook", secret: "pwh_x" }],
      vaultNames: [],
      tasksCancelled: 2,
      errors: [],
    });
    expect(m11.agents.get("u1", AGENT_ID)).toMatchObject({ paused: true, threadSessionId: null });
    expect(m11.agents.get("u1", AGENT_ID)?.quarantinedAt).not.toBeNull();
    expect(automation.abort).toHaveBeenCalledWith("u1", "t1");
    expect(automation.archive).toHaveBeenCalledWith("u1", "t1");
    expect(sessions.releaseIdle).toHaveBeenCalledWith("u1", "t1");
    // Resume clears the quarantine and asks for the password again.
    await expect(
      m11.rpc["agents.setPaused"]({ agentId: AGENT_ID, paused: false }, call()),
    ).rejects.toMatchObject({
      code: "step_up_required",
    });
    await m11.rpc["agents.setPaused"]({ agentId: AGENT_ID, paused: false }, call(owner));
    expect(m11.agents.get("u1", AGENT_ID)).toMatchObject({ paused: false, quarantinedAt: null });
  });

  it("answers agents.permissions from the profile, and reads a live thread's tools from the sessions module", async () => {
    const { m11, db, sessions } = parts();
    insertAgent(db);
    expect(await m11.rpc["agents.permissions"]({ agentId: AGENT_ID }, call())).toMatchObject({
      tools: { preset: "default", active: "unknown-until-start" },
      sandbox: { required: true, effective: "unavailable" },
      mcp: "owner's servers",
      egress: "off",
    });
    await m11.rpc["agents.openThread"]({ agentId: AGENT_ID }, call());
    sessions.agentSessions.activeTools.mockReturnValue({ tools: ["read", "bash"], truncated: false });
    expect(await m11.rpc["agents.permissions"]({ agentId: AGENT_ID }, call())).toMatchObject({
      tools: { active: ["read", "bash"] },
    });
    await expect(
      m11.rpc["agents.permissions"]({ agentId: AGENT_ID }, call(testCaller({ kind: "token" }))),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("serves the prompt chips of the agent's home", async () => {
    const { m11, db, home } = parts();
    insertAgent(db);
    mkdirSync(join(home, "agents", AGENT_ID, "prompts"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, "agents", AGENT_ID, "prompts", "daily.md"), "Summarise today");
    expect(await m11.rpc["agents.prompts"]({ agentId: AGENT_ID }, call())).toEqual({ names: ["daily.md"] });
    expect(await m11.rpc["agents.prompt"]({ agentId: AGENT_ID, name: "daily.md" }, call())).toEqual({
      text: "Summarise today",
    });
  });

  it("answers a replay of the quarantine's command id with conflict and runs the playbook once (m9)", async () => {
    const { m11, db, clock, automationModule } = parts();
    insertAgent(db);
    automationModule.agentLink.rotateSecretsOf.mockReturnValue({
      secrets: [{ triggerId: "t1", name: "Hook", secret: "pwh_x" }],
      failed: [],
    });
    const stored = new Map<string, { method: string; result: unknown }>();
    const dispatch = createDispatcher({
      handlers: m11.rpc as never,
      receipts: {
        find: (userId, commandId) => stored.get(`${userId}:${commandId}`) ?? null,
        save: (userId, commandId, method, result) =>
          void stored.set(`${userId}:${commandId}`, { method, result }),
        purge: () => 0,
        readOnly: false,
      },
      logger: silentLogger,
    });
    const owner = testCaller({ stepUpUntil: clock.now() + 60_000 });
    const frame = {
      id: 1,
      method: "agents.quarantine",
      params: { agentId: AGENT_ID },
      commandId: "cmd-00000001",
    };
    const ctx = {
      caller: owner,
      connectionId: "c1",
      openSubscription: () => "s",
      closeSubscription: () => {},
    };
    const first = await dispatch(frame as never, ctx);
    expect(first).toMatchObject({ ok: true, result: { secrets: [{ secret: "pwh_x" }] } });
    expect(JSON.stringify([...stored.values()])).not.toContain("pwh_x");
    expect(await dispatch({ ...frame, id: 2 } as never, ctx)).toEqual({
      id: 2,
      ok: false,
      error: { code: "conflict" },
    });
    expect(automationModule.agentLink.rotateSecretsOf).toHaveBeenCalledTimes(1);
  });
});
