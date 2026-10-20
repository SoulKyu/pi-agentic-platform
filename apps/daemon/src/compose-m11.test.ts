import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

describe("composeM11", () => {
  it("gives the sessions module the platform port and the lane lookup before anything starts", () => {
    const { sessions, laneOf } = parts();
    expect(sessions.setAgentPorts).toHaveBeenCalledTimes(2);
    const ports = sessions.setAgentPorts.mock.calls[0]?.[0] as {
      platform: { register: unknown };
      inLane(ownerId: string, cwd: string): boolean;
    };
    expect(typeof ports.platform.register).toBe("function");
    expect(ports.inLane("u1", "/lane")).toBe(true);
    expect(ports.inLane("u2", "/lane")).toBe(false);
    expect(ports.inLane("u1", "/elsewhere")).toBe(false);
    expect(laneOf).toHaveBeenCalled();
  });

  it("gives the sessions module the registry and the sandbox probe (M11R53, M11R57)", async () => {
    const { sessions, m11 } = parts();
    const ports = sessions.setAgentPorts.mock.calls[1]?.[0] as {
      agents: {
        profileOf(ownerId: string, agentId: string): unknown;
        probe: { ensure(): Promise<unknown> };
      };
    };
    expect(ports.agents.profileOf("u1", "atlas-1a2b")).toBeNull();
    // PAP_BWRAP names nothing: the boot probe ends `missing` without failing the boot, and a launch is refused on it.
    expect(await ports.agents.probe.ensure()).toEqual({ usable: false, reason: "missing" });
    expect(await m11.rpc["agents.sandboxStatus"]({}, {} as never)).toMatchObject({
      usable: false,
      path: null,
      reason: "missing",
    });
  });

  it("stops the dispatcher: later calls are unavailable", async () => {
    const { sessions, m11, clock } = parts();
    const ports = sessions.setAgentPorts.mock.calls[0]?.[0] as {
      platform: import("./modules/platform/index.ts").PlatformPort;
    };
    const replies: unknown[] = [];
    const call = () =>
      ports.platform.onRecord(
        { id: "s1", ownerId: "u1" },
        { type: "platform_call", id: "p1", op: "agent.notify", toolCallId: "t", args: { text: "x" } },
        (record) => replies.push(record),
      );
    // The agent of the mocked session row does not exist: the op ran and answered not_found.
    call();
    await clock.advance(0);
    m11.stop();
    call();
    expect(replies).toEqual([
      { type: "platform_result", id: "p1", ok: false, error: "not_found" },
      { type: "platform_result", id: "p1", ok: false, error: "unavailable" },
    ]);
  });

  it("serves the agents methods and gives the registry port", () => {
    const { m11 } = parts();
    expect(Object.keys(m11.rpc).sort()).toEqual([
      "agents.answerApproval",
      "agents.create",
      "agents.delete",
      "agents.events",
      "agents.get",
      "agents.list",
      "agents.markRead",
      "agents.openThread",
      "agents.permissions",
      "agents.prompt",
      "agents.prompts",
      "agents.quarantine",
      "agents.queueTask",
      "agents.recheckSandbox",
      "agents.resetThread",
      "agents.sandboxStatus",
      "agents.setPaused",
      "agents.status",
      "agents.trash",
      "agents.update",
      "memory.decide",
      "memory.forget",
      "memory.list",
      "memory.save",
      "memory.scopes",
      "memory.staged",
      "memory.status",
      "secrets.answerRequest",
      "secrets.declineRequest",
      "secrets.delete",
      "secrets.list",
      "secrets.set",
      "subagents.cancel",
      "subagents.profiles",
      "subscribe.agents",
    ]);
    expect(m11.agents.list("u1")).toEqual([]);
  });
});

describe("the agent thread's wiring (M11R59 to M11R63)", () => {
  it("opens a thread, counts a completed run as unread, publishes the rail and resets", async () => {
    const { m11, db, runEnds, hub, clock, sessions, automation } = parts();
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
    const openSubscription = vi.fn(() => "sub1");
    const ctx = { caller: testCaller(), openSubscription } as never;
    const unread = () => m11.agents.get("u1", "atlas-0001")?.unread;
    expect(await m11.rpc["agents.openThread"]({ agentId: "atlas-0001" }, ctx)).toEqual({ sessionId: "t1" });
    expect(m11.agents.get("u1", "atlas-0001")?.threadSessionId).toBe("t1");
    runEnds.forEach((listener) => listener({ status: "completed", sessionId: "t1", ownerId: "u1" }));
    expect(unread()).toBe(1);
    await clock.advance(250);
    expect(hub.publish).toHaveBeenCalledWith(
      "agents",
      "u1",
      expect.objectContaining({
        kind: "agent",
        agent: expect.objectContaining({ id: "atlas-0001", unread: 1 }),
      }),
    );
    expect(m11.agents.state("u1", "atlas-0001")).toBe("idle");
    expect(await m11.rpc["subscribe.agents"]({}, ctx)).toEqual({ sub: "sub1" });
    expect(openSubscription).toHaveBeenCalledWith("agents", "u1", undefined);
    await m11.rpc["agents.markRead"]({ agentId: "atlas-0001" }, ctx);
    expect(unread()).toBe(0);
    await m11.rpc["agents.resetThread"]({ agentId: "atlas-0001" }, ctx);
    expect(m11.agents.get("u1", "atlas-0001")?.threadSessionId).toBeNull();
    expect(automation.archive).toHaveBeenCalledWith("u1", "t1");
    expect(sessions.releaseIdle).toHaveBeenCalledWith("u1", "t1");
  });

  it("registers the stream's snapshot and stops listening with the entry", () => {
    const { m11, hub, runs } = parts();
    expect(hub.registerSnapshot).toHaveBeenCalledWith("agents", expect.any(Function));
    expect(runs.onRunStart).toHaveBeenCalled();
    m11.stop();
  });
});

describe("the agents' triggers and tasks (Task 10)", () => {
  const insertAgent = (db: ReturnType<typeof parts>["db"]) =>
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
  const stepUp = (clock: { now(): number }) => ({
    caller: testCaller({ stepUpUntil: clock.now() + 60_000 }),
    openSubscription: vi.fn(),
  });

  it("hands the automation module the registry, the agent sessions and the card writer", () => {
    const { automationModule, sessions, m11 } = parts();
    expect(automationModule.bindAgents).toHaveBeenCalledTimes(1);
    const ports = automationModule.bindAgents.mock.calls[0]?.[0] as unknown as {
      registry: unknown;
      sessions: unknown;
      events: { isolated: unknown; runCard: unknown; runCardEnded: unknown };
      threads: { open: unknown };
      spend: { agentSpentToday: unknown; taskRuns: unknown };
    };
    expect(ports.registry).toBe(m11.agents);
    expect(ports.sessions).toBe(sessions.agentSessions);
    expect(typeof ports.events.isolated).toBe("function");
    expect(typeof ports.events.runCard).toBe("function");
    expect(typeof ports.events.runCardEnded).toBe("function");
    expect(typeof ports.threads.open).toBe("function");
    expect(typeof ports.spend.agentSpentToday).toBe("function");
    expect(typeof ports.spend.taskRuns).toBe("function");
  });

  it("binds the automation link: a delete of an agent consults the running tasks and refuses while one runs", async () => {
    const { m11, db, automationModule, clock } = parts({ busy: true });
    insertAgent(db);
    await expect(
      m11.rpc["agents.delete"]({ agentId: "atlas-0001" }, stepUp(clock) as never),
    ).rejects.toMatchObject({ code: "session_busy" });
    expect(automationModule.agentLink.busy).toHaveBeenCalledWith("u1", "atlas-0001");
    expect(m11.agents.get("u1", "atlas-0001")).not.toBeNull();
    expect(automationModule.agentLink.deleteTriggersOf).not.toHaveBeenCalled();
  });

  it("asks for the triggers and the queue when nothing runs, then deletes the agent", async () => {
    const { m11, db, automationModule, clock } = parts({ busy: false });
    insertAgent(db);
    await m11.rpc["agents.delete"]({ agentId: "atlas-0001" }, stepUp(clock) as never);
    expect(automationModule.agentLink.deleteTriggersOf).toHaveBeenCalledWith("u1", "atlas-0001");
    expect(automationModule.agentLink.cancelQueuedOf).toHaveBeenCalledWith("u1", "atlas-0001");
    expect(m11.agents.get("u1", "atlas-0001")).toBeNull();
  });
});

describe("thread tasks, cards, budgets and pause (Task 11)", () => {
  const AGENT = "atlas-0001";
  const insertAgent = (db: ReturnType<typeof parts>["db"]) =>
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
  const ctx = (caller = testCaller()) => ({ caller, openSubscription: vi.fn() }) as never;
  const cardsPort = (automationModule: ReturnType<typeof parts>["automationModule"]) =>
    (
      automationModule.bindAgents.mock.calls[0]?.[0] as unknown as {
        events: {
          runCard(o: string, a: string, t: string, k: string, d: unknown): number | null;
          runCardEnded(o: string, a: string, t: string, d: unknown): boolean;
        };
        threads: { open(o: string, a: string): Promise<{ sessionId: string }> };
      }
    ).events;

  it("writes a card through the bound port: it counts unread, hints the open tab and reads back through agents.events", async () => {
    const { m11, db, hub, automationModule } = parts();
    insertAgent(db);
    const id = cardsPort(automationModule).runCard("u1", AGENT, "t1", "schedule", {
      title: "Round",
      state: "running",
    });
    expect(id).toBeGreaterThan(0);
    expect(m11.agents.get("u1", AGENT)?.unread).toBe(1);
    expect(hub.publish).toHaveBeenCalledWith("agents", "u1", { kind: "event", agentId: AGENT, eventId: id });
    const page = await m11.rpc["agents.events"]({ agentId: AGENT }, ctx());
    expect(page).toMatchObject({ more: false, events: [{ id, kind: "schedule", taskId: "t1" }] });
  });

  it("binds the rail's red dot: the newest unread card that failed puts the agent in failed", async () => {
    const { m11, db, automationModule } = parts();
    insertAgent(db);
    const events = cardsPort(automationModule);
    events.runCard("u1", AGENT, "t1", "task", { title: "Round", state: "running" });
    expect(m11.agents.state("u1", AGENT)).toBe("idle");
    events.runCardEnded("u1", AGENT, "t1", { state: "failed" });
    expect(m11.agents.state("u1", AGENT)).toBe("failed");
    await m11.rpc["agents.markRead"]({ agentId: AGENT }, ctx());
    expect(m11.agents.state("u1", AGENT)).toBe("idle");
  });

  it("opens the thread for the automation module through the same threads", async () => {
    const { m11, db, automationModule } = parts();
    insertAgent(db);
    const ports = automationModule.bindAgents.mock.calls[0]?.[0] as unknown as {
      threads: { open(o: string, a: string): Promise<{ sessionId: string }> };
    };
    expect(await ports.threads.open("u1", AGENT)).toEqual({ sessionId: "t1" });
    expect(m11.agents.get("u1", AGENT)?.threadSessionId).toBe("t1");
    expect(await m11.rpc["agents.openThread"]({ agentId: AGENT }, ctx())).toEqual({ sessionId: "t1" });
  });

  it("pauses and resumes through agents.setPaused, a token may", async () => {
    const { m11, db } = parts();
    insertAgent(db);
    const token = testCaller({ kind: "token", credentialId: "tok1" });
    expect(await m11.rpc["agents.setPaused"]({ agentId: AGENT, paused: true }, ctx(token))).toMatchObject({
      paused: true,
    });
    expect(m11.agents.get("u1", AGENT)?.paused).toBe(true);
    await m11.rpc["agents.setPaused"]({ agentId: AGENT, paused: false }, ctx());
    expect(m11.agents.get("u1", AGENT)?.paused).toBe(false);
  });

  it("answers agents.status in the owner's time zone, with the work the automation link lists", async () => {
    const { m11, db, automationModule, settings } = parts();
    insertAgent(db);
    const status = await m11.rpc["agents.status"]({ agentId: AGENT }, ctx());
    expect(status).toMatchObject({
      today: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
      billing: "unknown",
      tasks: [],
      triggers: [],
    });
    expect(settings.port.automation).toHaveBeenCalledWith("u1");
    expect(automationModule.agentLink.statusOf).toHaveBeenCalledWith(expect.anything(), AGENT);
  });

  it("queues a task for a browser and refuses a token", async () => {
    const { m11, db, automationModule } = parts();
    insertAgent(db);
    expect(await m11.rpc["agents.queueTask"]({ agentId: AGENT, prompt: "Do it" }, ctx())).toEqual({
      taskId: "queued-1",
    });
    expect(automationModule.agentLink.queueTask).toHaveBeenCalledWith({
      ownerId: "u1",
      agentId: AGENT,
      prompt: "Do it",
      handOff: null,
    });
    await expect(
      m11.rpc["agents.queueTask"](
        { agentId: AGENT, prompt: "Do it" },
        ctx(testCaller({ kind: "token", credentialId: "tok1" })),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
});

describe("the agents' vault (M11R86)", () => {
  it("hands vaultOf to the launch gate, tells the live workers on a set, and keeps the sealed file under $PAP_HOME/secrets/vault", async () => {
    const { m11, db, sessions, home } = parts();
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
    const ctx = { caller: testCaller() } as never;
    await m11.rpc["secrets.set"]({ agentId: "atlas-0001", name: "API_TOKEN", value: "v-1234" }, ctx);
    const ports = sessions.setAgentPorts.mock.calls[1]?.[0] as {
      agents: { vaultOf(ownerId: string, agentId: string): Record<string, string> };
    };
    expect(ports.agents.vaultOf("u1", "atlas-0001")).toEqual({ API_TOKEN: "v-1234" });
    expect(sessions.agentSessions.sendToAgent).toHaveBeenCalledWith("u1", "atlas-0001", {
      type: "vault_update",
      vault: { API_TOKEN: "v-1234" },
      once: [],
    });
    expect(existsSync(join(home, "secrets", "vault", "key"))).toBe(true);
    expect(await m11.rpc["secrets.list"]({ agentId: "atlas-0001" }, ctx)).toEqual({
      entries: [{ name: "API_TOKEN", updatedAt: expect.any(Number) }],
      state: "ok",
    });
  });

  it("deleting the agent drops its scope", async () => {
    const { m11, db, home } = parts();
    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
    );
    const ctx = { caller: testCaller({ stepUpUntil: Number.MAX_SAFE_INTEGER }) } as never;
    await m11.rpc["secrets.set"]({ agentId: "atlas-0001", name: "API_TOKEN", value: "v-1234" }, ctx);
    const file = join(home, "secrets", "vault", "u1", "agent-atlas-0001.json");
    expect(existsSync(file)).toBe(true);
    await m11.rpc["agents.delete"]({ agentId: "atlas-0001" }, ctx);
    expect(existsSync(file)).toBe(false);
  });
});

describe("the sandbox probe's folder (W5 carry 5, fix round 2)", () => {
  const source = readFileSync(fileURLToPath(new URL("./compose-m11-probe.ts", import.meta.url)), "utf8");

  it("is made in $PAP_HOME, and the canaries of a crashed probe are removed at boot", () => {
    expect(source).toContain("tmp: core.config.home");
    const { home } = parts({
      beforeBoot: (dir) => {
        mkdirSync(join(dir, "pap-probe-Stale1"));
        mkdirSync(join(dir, "agents"));
      },
    });
    expect(existsSync(join(home, "pap-probe-Stale1"))).toBe(false);
    expect(existsSync(join(home, "agents"))).toBe(true);
  });
});
