import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentBinding, createAgentTriggerLink } from "./trigger-agent.ts";
import { createTriggerStore } from "./store.ts";
import { type AutomationBed, createAutomationBed, parsedInput } from "./testing/bed.ts";
import { AGENT, fakeAgentPorts } from "./testing/agent-fakes.ts";

let bed: AutomationBed;
afterEach(() => bed.dispose());

const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const agentInput = (over: { agentId?: string; target?: "isolated" | "thread"; source?: object } = {}) =>
  parsedInput({
    name: "Atlas nightly",
    source: over.source ?? { type: "manual" },
    execution: { agent: { agentId: over.agentId ?? AGENT, target: over.target ?? "isolated" } },
    prompt: "Look and report.",
  });

function setup() {
  const binding = createAgentBinding();
  bed = createAutomationBed({ agents: binding });
  const fakes = fakeAgentPorts(bed.dir);
  fakes.add();
  binding.bind(fakes.ports);
  return { binding, fakes };
}

describe("saving an agent trigger (M11R65, M11R66)", () => {
  it("keeps the agent's home in cwd, the agent in its column, and no cwd in the config", () => {
    const { fakes } = setup();
    const { trigger } = bed.triggers.create(bed.owner(), agentInput());
    expect(trigger.cwd).toBe(fakes.homeOf(AGENT));
    expect(trigger.execution?.agent).toEqual({ agentId: AGENT, target: "isolated" });
    expect(trigger.agent).toEqual({ agentId: AGENT, target: "isolated" });
    const row = bed.db.get<{ cwd: string; agent_id: string; config: string }>(
      "SELECT cwd, agent_id, config FROM triggers WHERE id = $id",
      { id: trigger.id },
    );
    expect(row).toMatchObject({ cwd: fakes.homeOf(AGENT), agent_id: AGENT });
    expect(JSON.parse(row?.config ?? "").execution.cwd).toBeUndefined();
    expect(bed.triggers.get("u1", trigger.id)?.agentId).toBe(AGENT);
  });

  it("files no project for the agent's home, on create or on update (decision 85)", () => {
    setup();
    const { trigger } = bed.triggers.create(bed.owner(), agentInput());
    expect(bed.db.all("SELECT 1 FROM projects")).toEqual([]);
    expect(trigger.projectId).toBeNull();
    const updated = bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: trigger.revision,
      input: agentInput({ target: "thread" }),
    }).trigger;
    expect(updated.projectId).toBeNull();
    expect(bed.db.all("SELECT 1 FROM projects")).toEqual([]);
    bed.triggers.create(
      bed.owner(),
      parsedInput({ name: "P", source: { type: "manual" }, execution: { cwd: bed.folder }, prompt: "x" }),
    );
    expect(bed.db.all("SELECT 1 FROM projects")).toHaveLength(1);
  });

  it("asks for the password like every trigger save", () => {
    setup();
    expect(codeOf(() => bed.triggers.create(bed.unconfirmed(), agentInput()))).toBe("step_up_required");
    expect(bed.db.get("SELECT 1 AS n FROM triggers")).toBeUndefined();
  });

  it("answers not_found for another owner's agent, an unknown one, and before the agents exist", () => {
    const { fakes } = setup();
    fakes.add("sage-0000", "u2");
    expect(codeOf(() => bed.triggers.create(bed.owner(), agentInput({ agentId: "sage-0000" })))).toBe(
      "not_found",
    );
    expect(codeOf(() => bed.triggers.create(bed.owner(), agentInput({ agentId: "ghost-0000" })))).toBe(
      "not_found",
    );
    bed.dispose();
    bed = createAutomationBed();
    expect(codeOf(() => bed.triggers.create(bed.owner(), agentInput()))).toBe("not_found");
    expect(bed.db.get("SELECT 1 AS n FROM triggers")).toBeUndefined();
  });

  it("stores no trigger for a refused save, and no webhook secret file", () => {
    const { fakes } = setup();
    fakes.add("sage-0000", "u2");
    const input = agentInput({ agentId: "sage-0000", source: { type: "webhook" } });
    expect(codeOf(() => bed.triggers.create(bed.owner(), input))).toBe("not_found");
    expect(existsSync(bed.secretsDir)).toBe(false);
  });

  it("moves between a project folder and an agent on update, the column following the config", () => {
    setup();
    const { trigger } = bed.triggers.create(bed.owner(), agentInput());
    const project = parsedInput({
      name: "Atlas nightly",
      source: { type: "manual" },
      execution: { cwd: bed.folder },
      prompt: "Look and report.",
    });
    const updated = bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: trigger.revision,
      input: project,
    }).trigger;
    expect(updated.agent ?? null).toBeNull();
    expect(updated.cwd).toBe(bed.folder);
    expect(bed.db.get<{ agent_id: string | null }>("SELECT agent_id FROM triggers")?.agent_id).toBeNull();
    const back = bed.triggers.update(bed.owner(), {
      triggerId: trigger.id,
      baseRevision: updated.revision,
      input: agentInput({ target: "thread" }),
    }).trigger;
    expect(back.agent).toEqual({ agentId: AGENT, target: "thread" });
  });

  it("reads a row whose agent column disagrees with its config as unreadable, never half-trusted", () => {
    setup();
    const { trigger } = bed.triggers.create(bed.owner(), agentInput());
    bed.db.run("UPDATE triggers SET agent_id = 'sage-0000' WHERE id = $id", { id: trigger.id });
    expect(bed.triggers.get("u1", trigger.id)?.input).toBeNull();
    bed.db.run("UPDATE triggers SET agent_id = NULL WHERE id = $id", { id: trigger.id });
    expect(bed.triggers.get("u1", trigger.id)?.input).toBeNull();
  });
});

describe("deleting an agent deletes its triggers (M11R66, carry 1)", () => {
  it("removes the agent's triggers with their secret files, and only those", () => {
    const { binding, fakes } = setup();
    fakes.add("sage-0000", "u1");
    const changes: Array<{ triggerId: string; removed: boolean }> = [];
    const hook = bed.triggers.create(bed.owner(), agentInput({ source: { type: "webhook" } }));
    const plain = bed.triggers.create(bed.owner(), agentInput());
    const sage = bed.triggers.create(bed.owner(), agentInput({ agentId: "sage-0000" }));
    const project = bed.triggers.create(
      bed.owner(),
      parsedInput({
        name: "Project",
        source: { type: "manual" },
        execution: { cwd: bed.folder },
        prompt: "x",
      }),
    );
    expect(existsSync(join(bed.secretsDir, `${hook.trigger.id}.key`))).toBe(true);
    changes.length = 0;
    const link = createAgentTriggerLink({
      store: createTriggerStore(bed.db),
      secretsDir: bed.secretsDir,
      changed: (change) => changes.push({ triggerId: change.triggerId, removed: change.removed }),
      logger: bed.logger,
      rotate: () => ({ secret: "unused" }),
    });
    link.deleteTriggersOf("u1", AGENT);
    const left = bed.db.all<{ id: string }>("SELECT id FROM triggers ORDER BY id").map((row) => row.id);
    expect(left.sort()).toEqual([sage.trigger.id, project.trigger.id].sort());
    expect(existsSync(join(bed.secretsDir, `${hook.trigger.id}.key`))).toBe(false);
    expect(changes.map((change) => change.triggerId).sort()).toEqual(
      [hook.trigger.id, plain.trigger.id].sort(),
    );
    expect(changes.every((change) => change.removed)).toBe(true);
    expect(binding.ports()).not.toBeNull();
  });

  it("leaves another owner's triggers alone", () => {
    setup();
    const mine = bed.triggers.create(bed.owner(), agentInput());
    const link = createAgentTriggerLink({
      store: createTriggerStore(bed.db),
      secretsDir: bed.secretsDir,
      changed: vi.fn(),
      logger: bed.logger,
      rotate: () => ({ secret: "unused" }),
    });
    link.deleteTriggersOf("u2", AGENT);
    expect(bed.triggers.get("u1", mine.trigger.id)).not.toBeNull();
  });
});

describe("the binding", () => {
  it("is bound once: a second bind is a boot bug", () => {
    bed = createAutomationBed();
    const binding = createAgentBinding();
    const fakes = fakeAgentPorts("/nowhere");
    binding.bind(fakes.ports);
    expect(() => binding.bind(fakes.ports)).toThrow("already bound");
  });
});
