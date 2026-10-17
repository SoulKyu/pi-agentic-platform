import { existsSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { methods } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createQuarantine, QUARANTINE_STEP_MS } from "./quarantine.ts";
import type { AgentLinks } from "./links.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
const closed = new WeakSet<AgentsBed>();
const close = (): void => {
  if (bed && !closed.has(bed)) {
    closed.add(bed);
    bed.dispose();
  }
};
afterEach(close);
const { refusalOf } = bedHelpers(() => bed);

const SECRET = "pwh_0123456789abcdef0123456789abcdef0123456789a";

/** Fake links with a call log; `fail` names the calls that throw. */
function fakeLinks(log: string[], fail: ReadonlySet<string> = new Set()): AgentLinks {
  const call = <T>(name: string, value: T): T => {
    log.push(name);
    if (fail.has(name)) throw new Error(`${name} failed`);
    return value;
  };
  return {
    threads: {
      busy: () => false,
      archive: () => call("archive", undefined),
      releaseIdle: () => call("releaseIdle", undefined),
      abort: async () => call("abort", undefined),
    },
    automation: {
      busy: () => false,
      deleteTriggersOf: () => undefined,
      cancelQueuedOf: () => undefined,
      cancelAllOf: async () => call("cancelAll", 3),
      rotateSecretsOf: () =>
        call("rotate", { secrets: [{ triggerId: "t1", name: "Hook", secret: SECRET }], failed: [] }),
    },
    inbox: { clearReply: () => call("clearReply", undefined), removeAgentItems: () => undefined },
    vault: {
      drop: () => undefined,
      list: () => call("vaultList", { entries: [{ name: "API_TOKEN", updatedAt: 1 }], state: "ok" as const }),
    },
    onceValues: { drop: () => call("onceDrop", undefined) },
    requests: { cancelAllOf: () => call("requests", 2) },
  };
}

async function setup(fail: ReadonlySet<string> = new Set(), options: { quarantineThrows?: boolean } = {}) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  bed.db.run("UPDATE agents SET thread_session_id = 's1'");
  const log: string[] = [];
  bed.agents.setLinks(fakeLinks(log, fail));
  const store = options.quarantineThrows
    ? {
        ...bed.agents.store,
        quarantine: () => {
          log.push("quarantine");
          throw new Error("db down");
        },
      }
    : bed.agents.store;
  const changed = vi.fn();
  const quarantine = createQuarantine({
    store,
    links: bed.agents.links,
    guard: bed.guard,
    lock: async (agentId, work) => {
      log.push("lock");
      return work();
    },
    clock: bed.clock,
    logger: silentLogger,
    audit: bed.audit,
    requireStepUp: (caller, now) => {
      log.push("stepUp");
      if ((caller.stepUpUntil ?? 0) <= now) throw new PapError("step_up_required");
    },
    changed,
  });
  return { id, log, quarantine, changed };
}

describe("agents.quarantine (M11R115)", () => {
  it("is one command with a once-only answer and a browser-only permission", () => {
    expect(methods["agents.quarantine"]).toMatchObject({
      permission: "agents:admin",
      idempotent: false,
      secretResult: true,
    });
    expect(methods["agents.quarantine"].errors).toContain("step_up_required");
  });

  it("runs the steps in order under the thread lock and answers the secrets, the vault names and the count", async () => {
    const { id, log, quarantine, changed } = await setup();
    const answer = await quarantine.run(bed.owner(), id);
    expect(log).toEqual([
      "stepUp",
      "lock",
      "cancelAll",
      "abort",
      "releaseIdle",
      "archive",
      "clearReply",
      "requests",
      "onceDrop",
      "rotate",
      "vaultList",
    ]);
    expect(answer).toEqual({
      secrets: [{ triggerId: "t1", name: "Hook", secret: SECRET }],
      vaultNames: ["API_TOKEN"],
      tasksCancelled: 3,
      errors: [],
    });
    const record = bed.agents.port.get("u1", id);
    expect(record).toMatchObject({ paused: true, threadSessionId: null });
    expect(record?.quarantinedAt).toBe(bed.clock.now());
    expect(changed).toHaveBeenCalledWith("u1", id);
    const row = bed.auditRows().find((each) => each.reason === "agent quarantined");
    expect(row?.detail).toContain(id);
    expect(JSON.stringify(bed.auditRows())).not.toContain(SECRET);
  });

  it("asks for the password first: nothing is done without it", async () => {
    const { id, log, quarantine } = await setup();
    expect(await refusalOf(() => quarantine.run(bed.unconfirmed(), id))).toBe("step_up_required");
    expect(log).toEqual(["stepUp"]);
    expect(bed.agents.port.get("u1", id)?.quarantinedAt).toBeNull();
  });

  it("is not_found for another owner's agent and does nothing", async () => {
    const { id, log, quarantine } = await setup();
    expect(await refusalOf(() => quarantine.run(bed.owner({ userId: "u2" }), id))).toBe("not_found");
    expect(log.filter((entry) => entry !== "stepUp")).toEqual(["lock"]);
    expect(bed.agents.port.get("u1", id)?.quarantinedAt).toBeNull();
  });

  it("a failing thread step still runs the requests, the one-use values, the secrets and the names", async () => {
    const { id, log, quarantine } = await setup(new Set(["archive"]));
    const answer = await quarantine.run(bed.owner(), id);
    expect(log.slice(-4)).toEqual(["requests", "onceDrop", "rotate", "vaultList"]);
    expect(answer.errors).toEqual([{ step: "thread", code: "failed" }]);
    expect(answer.secrets).toHaveLength(1);
    expect(answer.vaultNames).toEqual(["API_TOKEN"]);
    // The thread step went on to clear the link the failed archive left, so a reopen cannot find the old thread.
    expect(log).toContain("clearReply");
  });

  it("a failing first step aborts with nothing else done and says command_failed", async () => {
    const { id, log, quarantine } = await setup(new Set(), { quarantineThrows: true });
    expect(await refusalOf(() => quarantine.run(bed.owner(), id))).toBe("command_failed");
    expect(log).toEqual(["stepUp", "lock", "quarantine"]);
  });

  it("every later step is wrapped: each failing in turn lands in errors and the rest still run", async () => {
    for (const [failing, step] of [
      ["cancelAll", "tasks"],
      ["requests", "requests"],
      ["onceDrop", "once_values"],
      ["rotate", "triggers"],
      ["vaultList", "vault"],
    ] as const) {
      close();
      const { id, log, quarantine } = await setup(new Set([failing]));
      const answer = await quarantine.run(bed.owner(), id);
      expect(answer.errors.map((each) => each.step)).toEqual([step]);
      expect(log).toContain("vaultList");
      expect(log).toContain("archive");
    }
  });

  it("a trigger whose secret could not be rotated is an error, and the ones that were rotated are still answered", async () => {
    const { id } = await setup();
    const links = fakeLinks([]);
    const partial = createQuarantine({
      store: bed.agents.store,
      links: () => ({
        ...links,
        automation: {
          busy: () => false,
          deleteTriggersOf: () => undefined,
          cancelQueuedOf: () => undefined,
          rotateSecretsOf: () => ({
            secrets: [{ triggerId: "t1", name: "Hook", secret: SECRET }],
            failed: ["t2"],
          }),
        },
      }),
      guard: bed.guard,
      lock: (_agentId, work) => work(),
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const answer = await partial.run(bed.owner(), id);
    expect(answer.secrets).toHaveLength(1);
    expect(answer.errors).toEqual([{ step: "triggers", code: "failed" }]);
  });

  it("a PapError of a step keeps its code, and nothing else of the error reaches the answer", async () => {
    const { id } = await setup();
    const links = fakeLinks([]);
    const quarantine = createQuarantine({
      store: bed.agents.store,
      links: () => ({
        ...links,
        requests: {
          cancelAllOf: () => {
            throw new Error("/home/ubuntu/.pap/secret path leaked");
          },
        },
      }),
      guard: bed.guard,
      lock: (_agentId, work) => work(),
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const answer = await quarantine.run(bed.owner(), id);
    expect(JSON.stringify(answer)).not.toContain("leaked");
  });

  it("resume clears quarantined_at too and asks for the password", async () => {
    const { id, quarantine } = await setup();
    await quarantine.run(bed.owner(), id);
    expect(await refusalOf(() => bed.agents.pause(bed.unconfirmed(), id, false))).toBe("step_up_required");
    expect(bed.agents.port.get("u1", id)?.quarantinedAt).not.toBeNull();
    const view = bed.agents.pause(bed.owner(), id, false);
    expect(view).toMatchObject({ state: "active", paused: false, quarantinedAt: null });
    expect(bed.auditRows().map((row) => row.reason)).toContain("agent resumed from quarantine");
  });

  it("pausing an agent that is not quarantined asks nothing and resuming it asks nothing", async () => {
    const { id } = await setup();
    expect(bed.agents.pause(bed.unconfirmed(), id, true).paused).toBe(true);
    expect(bed.agents.pause(bed.unconfirmed(), id, false).paused).toBe(false);
  });
});

describe("a step that never answers (time is bounded)", () => {
  it("reports a hanging abort as timeout, still archives and runs the later steps, and leaves no timer", async () => {
    const { id, log } = await setup();
    const links = fakeLinks(log);
    const hung = createQuarantine({
      store: bed.agents.store,
      links: () => ({
        ...links,
        threads: {
          busy: () => false,
          archive: () => log.push("archive"),
          releaseIdle: () => log.push("releaseIdle"),
          abort: () => new Promise<void>(() => {}),
        },
      }),
      guard: bed.guard,
      lock: (_agentId, work) => work(),
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const running = hung.run(bed.owner(), id);
    await vi.waitFor(() => expect(bed.clock.pending()).toBeGreaterThan(0), { timeout: 2_000 });
    await bed.clock.advance(QUARANTINE_STEP_MS);
    const answer = await running;
    expect(answer.errors).toEqual([{ step: "thread", code: "timeout" }]);
    expect(log).toContain("archive");
    expect(log.at(-1)).toBe("vaultList");
    expect(bed.clock.pending()).toBe(0);
  });

  it("clears its timers when every step answers", async () => {
    const { id, quarantine } = await setup();
    await quarantine.run(bed.owner(), id);
    expect(bed.clock.pending()).toBe(0);
  });

  it("reports a hanging task cancel as timeout and goes on with the thread", async () => {
    const { id, log } = await setup();
    const links = fakeLinks(log);
    const hung = createQuarantine({
      store: bed.agents.store,
      links: () => ({
        ...links,
        automation: {
          busy: () => false,
          deleteTriggersOf: () => undefined,
          cancelQueuedOf: () => undefined,
          cancelAllOf: () => new Promise<number>(() => {}),
        },
      }),
      guard: bed.guard,
      lock: (_agentId, work) => work(),
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const running = hung.run(bed.owner(), id);
    await vi.waitFor(() => expect(bed.clock.pending()).toBeGreaterThan(0), { timeout: 2_000 });
    await bed.clock.advance(QUARANTINE_STEP_MS);
    const answer = await running;
    expect(answer.errors).toEqual([{ step: "tasks", code: "timeout" }]);
    expect(answer.tasksCancelled).toBe(0);
    expect(log).toContain("archive");
  });

  it("refuses a resume while a quarantine of that agent is running (m2)", async () => {
    const { id } = await setup();
    let release: () => void = () => {};
    const held = createQuarantine({
      store: bed.agents.store,
      links: () => fakeLinks([]),
      lock: async (_agentId, work) => {
        await new Promise<void>((resolve) => (release = resolve));
        return work();
      },
      guard: bed.guard,
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const running = held.run(bed.owner(), id);
    await vi.waitFor(() => expect(bed.guard.quarantining.has(id)).toBe(true), { timeout: 2_000 });
    expect(await refusalOf(() => bed.agents.pause(bed.owner(), id, false))).toBe("session_busy");
    release();
    await running;
    expect(bed.guard.quarantining.has(id)).toBe(false);
    expect(bed.agents.pause(bed.owner(), id, false)).toMatchObject({ quarantinedAt: null });
  });
});

describe("resuming an agent whose delete was left half done (I2)", () => {
  it("is a conflict and the agent stays quarantined, so the delete's admission block holds (M11R48)", async () => {
    bed = createAgentsBed();
    const { id } = await bed.agents.create(bed.owner(), agentInput());
    bed.agents.setLinks({
      onceValues: {
        drop: () => {
          throw new Error("boom");
        },
      },
    });
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("command_failed");
    expect(existsSync(join(bed.papHome, "agents", id))).toBe(false);
    expect(bed.agents.port.get("u1", id)?.quarantinedAt).not.toBeNull();
    expect(await refusalOf(() => bed.agents.pause(bed.owner(), id, false))).toBe("conflict");
    expect(bed.agents.port.get("u1", id)).toMatchObject({ paused: true });
    expect(bed.agents.port.get("u1", id)?.quarantinedAt).not.toBeNull();
  });

  it("keeps refusing a resume while a second quarantine of the agent runs after the first ended (m-a)", async () => {
    const { id } = await setup();
    const releases: Array<() => void> = [];
    const queued = createQuarantine({
      store: bed.agents.store,
      links: () => fakeLinks([]),
      guard: bed.guard,
      lock: async (_agentId, work) => {
        await new Promise<void>((resolve) => releases.push(resolve));
        return work();
      },
      clock: bed.clock,
      logger: silentLogger,
      audit: bed.audit,
      requireStepUp: () => undefined,
      changed: () => undefined,
    });
    const first = queued.run(bed.owner(), id);
    const second = queued.run(bed.owner(), id);
    await vi.waitFor(() => expect(releases).toHaveLength(2), { timeout: 2_000 });
    releases[0]?.();
    await first;
    expect(await refusalOf(() => bed.agents.pause(bed.owner(), id, false))).toBe("session_busy");
    releases[1]?.();
    await second;
    expect(bed.guard.quarantining.has(id)).toBe(false);
    expect(bed.agents.pause(bed.owner(), id, false)).toMatchObject({ quarantinedAt: null });
  });
});
