import { describe, expect, it } from "vitest";
import "../../i18n/register-automation.ts";
import { agentColumns, requestedByName } from "./agent-columns.vm.ts";
import { agentOf, projectOf, taskOf, triggerOf } from "./board-bed.tsx";
import { groupColumns } from "./board.vm.ts";

const ATLAS = agentOf("atlas-1a2b", "Atlas");
const BOLT = agentOf("bolt-0001", "Bolt");
const projects = new Map([["p1", projectOf("p1", "atlas")]]);

describe("agentColumns", () => {
  const tasks = [
    taskOf({ id: "a", agentId: ATLAS.id, target: "thread", projectId: null, state: "running", costUsd: 0.5 }),
    taskOf({ id: "b", agentId: ATLAS.id, target: "isolated", projectId: null, state: "done", costUsd: 0.25 }),
    taskOf({ id: "c", agentId: BOLT.id, projectId: null, state: "queued", startedAt: null }),
    taskOf({ id: "d", projectId: "p1" }),
  ];
  const triggers = [
    triggerOf({ id: "g1", agentId: ATLAS.id, projectId: null }),
    triggerOf({ id: "g2", projectId: "p1" }),
  ];

  it("makes one column per agent, in the agents' order, even for an agent with nothing yet", () => {
    const columns = agentColumns(tasks, triggers, [BOLT, ATLAS, agentOf("cato-0002", "Cato")]);
    expect(columns.map((column) => column.agent.id)).toEqual([BOLT.id, ATLAS.id, "cato-0002"]);
    expect(columns[2]?.tasks).toEqual([]);
  });

  it("puts an agent's tasks and triggers in its column, with the slots in use and today's cost", () => {
    const atlas = agentColumns(tasks, triggers, [ATLAS, BOLT])[0];
    expect(atlas?.tasks.map((task) => task.id)).toEqual(["a", "b"]);
    expect(atlas?.triggers.map((trigger) => trigger.id)).toEqual(["g1"]);
    expect(atlas?.running).toBe(1);
  });

  it("keeps agent tasks and triggers out of the project columns, and project ones out of the agent's", () => {
    const columns = groupColumns(tasks, triggers, projects, new Set([ATLAS.id, BOLT.id]));
    expect(columns.map((column) => column.key)).toEqual(["p1"]);
    expect(columns[0]?.tasks.map((task) => task.id)).toEqual(["d"]);
    expect(columns[0]?.triggers.map((trigger) => trigger.id)).toEqual(["g2"]);
  });

  it("leaves the tasks of an agent that is gone in 'Other folders'", () => {
    const columns = groupColumns(tasks, triggers, projects, new Set([BOLT.id]));
    expect(columns.map((column) => column.key)).toEqual(["p1", "other"]);
    expect(columns[1]?.tasks.map((task) => task.id)).toEqual(["a", "b"]);
  });
});

describe("requestedByName", () => {
  it("names the agent that delegated the task, and nothing for any other task", () => {
    const delegated = taskOf({ origin: "delegate", agentId: BOLT.id, requestedBy: ATLAS.id });
    expect(requestedByName(delegated, [ATLAS, BOLT])).toBe("Atlas");
    expect(requestedByName(taskOf({ agentId: BOLT.id }), [ATLAS, BOLT])).toBeNull();
    expect(requestedByName(delegated, [BOLT])).toBeNull();
  });
});
