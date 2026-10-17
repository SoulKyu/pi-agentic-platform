import { afterEach, describe, expect, it } from "vitest";
import { fakeAgentPorts, insertAgentTrigger } from "./testing/agent-fakes.ts";
import { createRunnerBed, type RunnerBed } from "./testing/runner-bed.ts";
import { testCaller } from "../../testing/caller.ts";
import { TOKEN_PERMISSIONS } from "@pap/contracts";
import { taskActions } from "./rpc.ts";

let bed: RunnerBed;
afterEach(() => bed.dispose());

const TASK = "0b1c2d3e-0001-4000-8000-000000000001";
const token = () =>
  testCaller({ kind: "token", credentialId: "tok1", permissions: new Set(TOKEN_PERMISSIONS) });

function failedTask(target: "isolated" | "thread", over: { tainted?: boolean; project?: boolean } = {}) {
  bed = createRunnerBed();
  const fakes = fakeAgentPorts(bed.home);
  fakes.add();
  const triggerId = insertAgentTrigger(bed.db, fakes.homeOf("atlas-1a2b"), { target });
  bed.engine.store.insert({
    id: TASK,
    ownerId: "u1",
    triggerId,
    origin: "schedule",
    cwd: fakes.homeOf("atlas-1a2b"),
    prompt: "p",
    tainted: over.tainted ?? false,
    gated: true,
    policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
    title: "t",
    detail: null,
    retryOf: null,
    retryOnInterrupt: false,
    maxRunMs: 600_000,
    maxRunUsd: null,
    at: bed.clock.now(),
    ...(over.project ? {} : { agentId: "atlas-1a2b", target }),
  });
  bed.db.run("UPDATE tasks SET state = 'failed', ended_at = $at WHERE id = $id", {
    id: TASK,
    at: bed.clock.now(),
  });
  return taskActions(bed.engine.runner, bed.engine.stream, bed.releaseTools());
}

describe("Retry of a task on the agent's thread (M11R65, owner m15)", () => {
  it("is forbidden for a token and makes no task", () => {
    const actions = failedTask("thread");
    expect(() => actions.retry("u1", TASK, token())).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(bed.db.all("SELECT id FROM tasks")).toHaveLength(1);
  });

  it("goes through for the owner's browser: a new task of the same thread target", () => {
    const actions = failedTask("thread");
    const { taskId } = actions.retry("u1", TASK, bed.owner());
    expect(bed.db.get("SELECT target, retry_of FROM tasks WHERE id = $id", { id: taskId })).toEqual({
      target: "thread",
      retry_of: TASK,
    });
  });

  it("still lets a token retry an isolated agent task", () => {
    const actions = failedTask("isolated");
    expect(actions.retry("u1", TASK, token()).taskId).toBeTruthy();
  });

  /** The owner edits the trigger after the task failed: a manual trigger that prompts the agent's thread. */
  const editToThread = () => {
    const row = bed.db.get<{ config: string }>("SELECT config FROM triggers");
    const config = JSON.parse(row?.config ?? "{}");
    config.source = { type: "manual" };
    config.execution.agent.target = "thread";
    bed.db.run("UPDATE triggers SET config = $config, source_type = 'manual', revision = revision + 1", {
      config: JSON.stringify(config),
    });
  };

  it("decides on the trigger's CURRENT target: a token is forbidden after the edit", () => {
    const actions = failedTask("isolated", { tainted: true });
    editToThread();
    expect(() => actions.retry("u1", TASK, token())).toThrow(expect.objectContaining({ code: "forbidden" }));
    expect(bed.db.all("SELECT id FROM tasks")).toHaveLength(1);
  });

  it("refuses a tainted prompt onto the thread for the owner too: bad_request, no task", () => {
    const actions = failedTask("isolated", { tainted: true });
    editToThread();
    expect(() => actions.retry("u1", TASK, bed.owner())).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(bed.db.all("SELECT id FROM tasks")).toHaveLength(1);
  });

  it("refuses the same for an old project task whose trigger became a thread trigger", () => {
    const actions = failedTask("isolated", { tainted: true, project: true });
    editToThread();
    expect(() => actions.retry("u1", TASK, bed.owner())).toThrow(
      expect.objectContaining({ code: "bad_request" }),
    );
    expect(() => actions.retry("u1", TASK, token())).toThrow(expect.objectContaining({ code: "forbidden" }));
  });

  it("lets the owner retry an untainted prompt onto the thread", () => {
    const actions = failedTask("isolated");
    editToThread();
    const { taskId } = actions.retry("u1", TASK, bed.owner());
    expect(bed.db.get("SELECT target FROM tasks WHERE id = $id", { id: taskId })).toEqual({
      target: "thread",
    });
  });
});
