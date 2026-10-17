import { afterEach, describe, expect, it, vi } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import type { AgentLinks } from "./links.ts";
import { createQueueTask } from "./queue.ts";
import { agentInput, type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    return (error as { code?: string }).code ?? "other";
  }
  return "no error";
};

async function setup() {
  bed = createAgentsBed();
  const atlas = await bed.agents.create(bed.owner(), agentInput());
  const birch = await bed.agents.create(bed.owner(), agentInput({ name: "Birch" }));
  const queue = vi.fn<NonNullable<NonNullable<AgentLinks["automation"]>["queueTask"]>>(() => ({
    taskId: "task-1",
  }));
  const queueTask = createQueueTask({
    store: bed.agents.store,
    links: () => ({
      automation: { busy: vi.fn(), deleteTriggersOf: vi.fn(), cancelQueuedOf: vi.fn(), queueTask: queue },
    }),
  });
  return { atlas: atlas.id, birch: birch.id, queue, queueTask };
}

describe("agents.queueTask (M11R77)", () => {
  it("queues a thread task for the owner's agent and answers with its id", async () => {
    const { atlas, queue, queueTask } = await setup();
    expect(queueTask(testCaller(), { agentId: atlas, prompt: "Summarise the week" })).toEqual({
      taskId: "task-1",
    });
    expect(queue).toHaveBeenCalledWith({
      ownerId: "u1",
      agentId: atlas,
      prompt: "Summarise the week",
      handOff: null,
    });
  });

  it("refuses a token: forbidden, nothing queued", async () => {
    const { atlas, queue, queueTask } = await setup();
    const token = testCaller({ kind: "token", credentialId: "tok1" });
    expect(codeOf(() => queueTask(token, { agentId: atlas, prompt: "x" }))).toBe("forbidden");
    expect(queue).not.toHaveBeenCalled();
  });

  it("refuses any caller that is not a browser session, the internal automation caller included (fail closed)", async () => {
    const { atlas, queue, queueTask } = await setup();
    const automation = testCaller({ kind: "automation" as never, credentialId: "automation" });
    expect(codeOf(() => queueTask(automation, { agentId: atlas, prompt: "x" }))).toBe("forbidden");
    expect(queue).not.toHaveBeenCalled();
  });

  it("names the agent a hand-over comes from, as the owner's own agent", async () => {
    const { atlas, birch, queue, queueTask } = await setup();
    queueTask(testCaller(), {
      agentId: atlas,
      prompt: "Use this",
      handOff: { fromAgentId: birch, quote: "Birch said so" },
    });
    expect(queue).toHaveBeenCalledWith(
      expect.objectContaining({ handOff: { fromName: "Birch", quote: "Birch said so" } }),
    );
    expect(
      codeOf(() =>
        queueTask(testCaller(), {
          agentId: atlas,
          prompt: "x",
          handOff: { fromAgentId: "ghost-0000", quote: "q" },
        }),
      ),
    ).toBe("not_found");
  });

  it("queues for a paused agent, which runs it on resume", async () => {
    const { atlas, queue, queueTask } = await setup();
    bed.agents.setPaused("u1", atlas, true);
    queueTask(testCaller(), { agentId: atlas, prompt: "later" });
    expect(queue).toHaveBeenCalledTimes(1);
  });

  it("refuses a quarantined agent, an agent that is not the owner's, and a missing link", async () => {
    const { atlas, queue, queueTask } = await setup();
    bed.agents.store.quarantine("u1", atlas, 5);
    expect(codeOf(() => queueTask(testCaller(), { agentId: atlas, prompt: "x" }))).toBe("agent_paused");
    expect(codeOf(() => queueTask(testCaller({ userId: "u2" }), { agentId: atlas, prompt: "x" }))).toBe(
      "not_found",
    );
    expect(queue).not.toHaveBeenCalled();
    const unbound = createQueueTask({ store: bed.agents.store, links: () => ({}) });
    bed.agents.store.update("u1", atlas, 1, { name: "Atlas", profile: JSON.stringify(agentInput()), at: 1 });
    expect(codeOf(() => unbound(testCaller(), { agentId: "ghost-0000", prompt: "x" }))).toBe("not_found");
  });
});

describe("agents.setPaused (M11R75)", () => {
  it("pauses and resumes, and answers with the agent's view", async () => {
    const { atlas } = await setup();
    expect(bed.agents.pause(testCaller(), atlas, true)).toMatchObject({
      id: atlas,
      paused: true,
      state: "paused",
    });
    expect(bed.agents.pause(testCaller(), atlas, false)).toMatchObject({ paused: false, state: "active" });
  });

  it("tells the registry's listeners, so the rail follows", async () => {
    const { atlas } = await setup();
    const heard = vi.fn();
    bed.agents.port.onChange(heard);
    bed.agents.pause(testCaller(), atlas, true);
    expect(heard).toHaveBeenCalledWith({ ownerId: "u1", agentId: atlas, removed: false });
  });

  it("refuses to resume while a delete is in flight and for a quarantined agent without the password (M11R115), and reads another owner's as not_found", async () => {
    const { atlas, birch } = await setup();
    bed.guard.deleting.add(atlas);
    bed.agents.pause(testCaller(), atlas, true);
    expect(codeOf(() => bed.agents.pause(testCaller(), atlas, false))).toBe("session_busy");
    bed.guard.deleting.delete(atlas);
    bed.agents.store.quarantine("u1", birch, 5);
    expect(codeOf(() => bed.agents.pause(testCaller(), birch, false))).toBe("step_up_required");
    expect(codeOf(() => bed.agents.pause(testCaller({ userId: "u2" }), atlas, true))).toBe("not_found");
  });
});

describe("fix round 1: a switch is audited (minor 2)", () => {
  it("writes one audit row for a pause and one for a resume, whoever calls it, with the agent id and no profile text", async () => {
    const { atlas } = await setup();
    bed.agents.pause(testCaller(), atlas, true);
    bed.agents.pause(testCaller({ kind: "token", credentialId: "tok1" }), atlas, false);
    const rows = bed
      .auditRows()
      .filter((row) => row.reason.startsWith("agent p") || row.reason.startsWith("agent r"));
    expect(rows.map((row) => [row.actor, row.reason])).toEqual([
      ["user", "agent paused"],
      ["token", "agent resumed"],
    ]);
    expect(rows.map((row) => JSON.parse(row.detail))).toEqual([{ agentId: atlas }, { agentId: atlas }]);
  });
});
