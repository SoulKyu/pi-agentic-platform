import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentLinks } from "./links.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const { refusalOf, rowCount, insertRows } = bedHelpers(() => bed);

describe("delete (M11R48, M11R183)", () => {
  const made = async () => {
    await bed.agents.create(bed.owner(), agentInput());
    return "atlas-0000";
  };
  const pausedNow = (): boolean => bed.agents.port.get("u1", "atlas-0000")?.paused ?? false;

  it("always asks for the password", async () => {
    bed = createAgentsBed();
    const id = await made();
    expect(await refusalOf(() => bed.agents.remove(bed.unconfirmed(), id))).toBe("step_up_required");
    expect(bed.agents.port.get("u1", id)).not.toBeNull();
    expect(pausedNow()).toBe(false);
  });

  it("does its steps in order: pause, triggers, tasks, thread, vault, trash, use-once values, row", async () => {
    bed = createAgentsBed();
    const id = await made();
    bed.db.run("UPDATE agents SET thread_session_id = 's1'");
    const home = join(bed.papHome, "agents", id);
    mkdirSync(join(bed.papHome, "agents", ".runs", id, "task-1"), { recursive: true });
    const log: string[] = [];
    const snap = (step: string) =>
      log.push(
        `${step} paused=${pausedNow()} home=${existsSync(home)} row=${bed.agents.port.get("u1", id) !== null}`,
      );
    const links: AgentLinks = {
      threads: { busy: () => false, archive: () => snap("archive"), releaseIdle: vi.fn() },
      automation: {
        busy: () => false,
        deleteTriggersOf: () => snap("triggers"),
        cancelQueuedOf: async () => void snap("tasks"),
      },
      vault: { drop: () => snap("vault") },
      onceValues: { drop: () => snap("once") },
    };
    bed.agents.setLinks(links);
    const answer = await bed.agents.remove(bed.owner(), id);
    expect(log).toEqual([
      "triggers paused=true home=true row=true",
      "tasks paused=true home=true row=true",
      "archive paused=true home=true row=true",
      "vault paused=true home=true row=true",
      "once paused=true home=false row=true",
    ]);
    expect(answer).toEqual({ trashedAs: "atlas-0000-1700000000000" });
    expect(bed.agents.port.get("u1", id)).toBeNull();
    expect(readdirSync(join(bed.papHome, "agents", ".trash")).sort()).toEqual([
      "atlas-0000-1700000000000",
      "atlas-0000-1700000000000.runs",
    ]);
    expect(existsSync(join(bed.papHome, "agents", ".trash", "atlas-0000-1700000000000", "MEMORY.md"))).toBe(
      true,
    );
  });

  it("refuses while the thread runs (session_busy) and puts paused back as it was", async () => {
    bed = createAgentsBed();
    const id = await made();
    bed.db.run("UPDATE agents SET thread_session_id = 's1'");
    const cleanup = vi.fn();
    bed.agents.setLinks({
      threads: { busy: () => true, archive: cleanup, releaseIdle: vi.fn() },
      automation: { busy: () => false, deleteTriggersOf: cleanup, cancelQueuedOf: cleanup },
    });
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
    expect(pausedNow()).toBe(false);
    expect(cleanup).not.toHaveBeenCalled();
    expect(existsSync(join(bed.papHome, "agents", id))).toBe(true);
    // An agent the owner had paused stays paused.
    bed.agents.setPaused("u1", id, true);
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
    expect(pausedNow()).toBe(true);
  });

  it("refuses while a task of the agent is running or starting", async () => {
    bed = createAgentsBed();
    const id = await made();
    bed.agents.setLinks({
      automation: { busy: () => true, deleteTriggersOf: vi.fn(), cancelQueuedOf: vi.fn() },
    });
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
    expect(pausedNow()).toBe(false);
  });

  it("sees a task the runner admitted just before the pause, and defers one admitted after it (RT-20)", async () => {
    bed = createAgentsBed();
    const id = await made();
    const runner = {
      running: false,
      // M10R36's admission: it reads `paused` and marks the task running in one synchronous step.
      admit(): "running" | "deferred" {
        if (bed.agents.port.get("u1", id)?.paused) return "deferred";
        runner.running = true;
        return "running";
      },
    };
    const after: string[] = [];
    const pausedAtCheck: boolean[] = [];
    bed.agents.setLinks({
      automation: {
        busy: () => {
          // The pause is already in place when the check reads the runner (M11R183).
          pausedAtCheck.push(pausedNow());
          return runner.running;
        },
        deleteTriggersOf: () => void after.push(runner.admit()),
        cancelQueuedOf: vi.fn(),
      },
    });
    expect(runner.admit()).toBe("running");
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
    expect(after).toEqual([]);
    expect(pausedNow()).toBe(false);
    runner.running = false;
    await bed.agents.remove(bed.owner(), id);
    expect(after).toEqual(["deferred"]);
    // The refused delete reads once; the one that goes through reads again after the await (carry 4).
    expect(pausedAtCheck).toEqual([true, true, true]);
    expect(runner.running).toBe(false);
  });

  it("answers session_busy to a resume while a delete of that agent is in flight, and pausing stays allowed", async () => {
    bed = createAgentsBed();
    const id = await made();
    const seen: string[] = [];
    bed.agents.setLinks({
      automation: {
        busy: () => false,
        deleteTriggersOf: vi.fn(),
        cancelQueuedOf: async () => {
          for (const paused of [false, true]) {
            try {
              bed.agents.setPaused("u1", id, paused);
              seen.push(`${paused}:ok`);
            } catch (error) {
              seen.push(`${paused}:${error instanceof PapError ? error.code : "other"}`);
            }
          }
          expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("session_busy");
        },
      },
    });
    await bed.agents.remove(bed.owner(), id);
    expect(seen).toEqual(["false:session_busy", "true:ok"]);
    // The set is empty again: a new agent of the same id would resume freely.
  });

  it("leaves the row quarantined and logs when a step after the rename fails; a retry finishes", async () => {
    bed = createAgentsBed();
    const id = await made();
    let failures = 1;
    bed.agents.setLinks({
      onceValues: {
        drop: () => {
          if (failures-- > 0) throw new Error("boom");
        },
      },
    });
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("command_failed");
    expect(existsSync(join(bed.papHome, "agents", id))).toBe(false);
    expect(bed.agents.port.get("u1", id)).toMatchObject({ paused: true, quarantinedAt: 1_700_000_000_000 });
    expect(bed.logs.some((line) => line.msg === "agent_delete_incomplete")).toBe(true);
    expect(await bed.agents.remove(bed.owner(), id)).toEqual({ trashedAs: "atlas-0000-1700000000000" });
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });

  it("quarantines the agent and audits it when the scratch folders cannot follow the home; a retry finishes", async () => {
    bed = createAgentsBed();
    const id = await made();
    const agents = join(bed.papHome, "agents");
    mkdirSync(join(agents, ".runs", id, "task-1"), { recursive: true });
    mkdirSync(join(agents, ".trash", `${id}-1700000000000.runs`, "busy"), { recursive: true });
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("command_failed");
    expect(existsSync(join(agents, id))).toBe(false);
    expect(bed.agents.port.get("u1", id)).toMatchObject({ paused: true, quarantinedAt: 1_700_000_000_000 });
    expect(bed.logs.some((line) => line.msg === "agent_delete_incomplete")).toBe(true);
    const rows = bed.auditRows().filter((row) => row.reason === "agent delete incomplete");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]?.detail ?? "{}")).toEqual({ agentId: id });
    expect(await bed.agents.remove(bed.owner(), id)).toEqual({ trashedAs: `${id}-1700000000000` });
    expect(bed.agents.port.get("u1", id)).toBeNull();
  });

  it("fails the step, with a log, and leaves the home when its scratch folder is a link", async () => {
    bed = createAgentsBed();
    const id = await made();
    const agents = join(bed.papHome, "agents");
    mkdirSync(join(agents, ".runs"));
    symlinkSync(bed.dir, join(agents, ".runs", id));
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), id))).toBe("command_failed");
    expect(existsSync(join(agents, id))).toBe(true);
    expect(bed.logs.some((line) => line.msg === "agent_delete_failed")).toBe(true);
    expect(bed.agents.port.get("u1", id)).toMatchObject({ quarantinedAt: null });
  });

  it("deletes an unreadable agent with no home folder", async () => {
    bed = createAgentsBed();
    insertRows(1);
    expect(bed.agents.port.get("u1", "bulk-0000")?.input).toBeNull();
    expect(await bed.agents.remove(bed.owner(), "bulk-0000")).toEqual({ trashedAs: "" });
    expect(rowCount()).toBe(0);
  });

  it("cascades the agent's events and requests", async () => {
    bed = createAgentsBed();
    const id = await made();
    bed.db.run(
      "INSERT INTO agent_events (agent_id, owner_id, kind, data, at) VALUES ($id, 'u1', 'notify', '{}', 1)",
      { id },
    );
    bed.db.run(
      `INSERT INTO agent_requests (id, agent_id, owner_id, session_id, kind, title, state, created_at, expires_at)
       VALUES ('r1', $id, 'u1', 's', 'approve', 't', 'pending', 1, 2)`,
      { id },
    );
    await bed.agents.remove(bed.owner(), id);
    expect(bed.db.get("SELECT 1 AS n FROM agent_events")).toBeUndefined();
    expect(bed.db.get("SELECT 1 AS n FROM agent_requests")).toBeUndefined();
  });

  it("answers not_found for another owner's agent", async () => {
    bed = createAgentsBed();
    const id = await made();
    expect(await refusalOf(() => bed.agents.remove(bed.owner({ userId: "u2" }), id))).toBe("not_found");
    expect(existsSync(join(bed.papHome, "agents", id))).toBe(true);
  });
});

describe("pause and the port", () => {
  it("setPaused switches without a revision bump and tells the listeners", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.unconfirmed(), agentInput());
    const heard: unknown[] = [];
    const stop = bed.agents.port.onChange((change) => heard.push(change));
    expect(bed.agents.setPaused("u1", "atlas-0000", true)).toMatchObject({ paused: true, revision: 1 });
    expect(bed.agents.view(bed.unconfirmed(), "atlas-0000").state).toBe("paused");
    bed.agents.update(bed.unconfirmed(), {
      agentId: "atlas-0000",
      baseRevision: 1,
      input: agentInput({ role: "x" }),
    });
    stop();
    bed.agents.setPaused("u1", "atlas-0000", false);
    expect(heard).toEqual([
      { ownerId: "u1", agentId: "atlas-0000", removed: false },
      { ownerId: "u1", agentId: "atlas-0000", removed: false },
    ]);
    expect(() => bed.agents.setPaused("u2", "atlas-0000", true)).toThrow(PapError);
  });

  it("lists an unreadable agent and a listener that throws never fails the change", async () => {
    bed = createAgentsBed();
    insertRows(1);
    bed.agents.port.onChange(() => {
      throw new Error("listener");
    });
    await bed.agents.create(bed.unconfirmed(), agentInput());
    const listed = bed.agents.list(bed.unconfirmed());
    expect(listed.agents.map((agent) => [agent.name, agent.state])).toEqual([
      ["bulk0", "unreadable"],
      ["Atlas", "active"],
    ]);
    expect(listed.truncated).toBe(false);
    expect(bed.logs.some((line) => line.msg === "agent_change_listener_failed")).toBe(true);
    expect(bed.agents.port.list("u1")).toHaveLength(2);
  });

  it("never touches another agent's home when a new one is made", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.unconfirmed(), agentInput());
    writeFileSync(join(bed.papHome, "agents", "atlas-0000", "MEMORY.md"), "owner edit");
    await bed.agents.create(bed.unconfirmed(), agentInput({ name: "Bolt" }));
    expect(readFileSync(join(bed.papHome, "agents", "atlas-0000", "MEMORY.md"), "utf8")).toBe("owner edit");
  });
});

describe("late-bound links (fix round 1)", () => {
  it("keeps the links already bound when another is bound, and a busy thread still refuses the delete", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.owner(), agentInput());
    bed.db.run("UPDATE agents SET thread_session_id = 's1'");
    bed.agents.setLinks({ threads: { busy: () => true, archive: vi.fn(), releaseIdle: vi.fn() } });
    bed.agents.setLinks({ vault: { drop: vi.fn() } });
    bed.agents.setLinks({
      automation: { busy: () => false, deleteTriggersOf: vi.fn(), cancelQueuedOf: vi.fn() },
    });
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), "atlas-0000"))).toBe("session_busy");
    expect(existsSync(join(bed.papHome, "agents", "atlas-0000"))).toBe(true);
  });

  it("throws when a link that is already bound is bound again, and keeps the first", async () => {
    bed = createAgentsBed();
    await bed.agents.create(bed.owner(), agentInput());
    bed.db.run("UPDATE agents SET thread_session_id = 's1'");
    bed.agents.setLinks({ threads: { busy: () => true, archive: vi.fn(), releaseIdle: vi.fn() } });
    expect(() =>
      bed.agents.setLinks({ threads: { busy: () => false, archive: vi.fn(), releaseIdle: vi.fn() } }),
    ).toThrow(/threads/);
    expect(await refusalOf(() => bed.agents.remove(bed.owner(), "atlas-0000"))).toBe("session_busy");
  });
});
