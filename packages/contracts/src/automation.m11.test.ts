import { describe, expect, it } from "vitest";
import { methods, TaskTrigger, TaskView, TriggerInput, TriggerView } from "./index.ts";

const AGENT = "atlas-1a2b";
const input = (source: unknown, execution: unknown) => ({
  name: "Nightly",
  source,
  execution,
  prompt: "Look and report.",
});
const parse = (source: unknown, execution: unknown) => TriggerInput.safeParse(input(source, execution));

describe("TriggerExecution.agent (M11R65)", () => {
  it("parses an agent trigger without a cwd, the agent being the target", () => {
    const parsed = TriggerInput.parse(
      input({ type: "manual" }, { agent: { agentId: AGENT, target: "isolated" } }),
    );
    expect(parsed.execution.agent).toEqual({ agentId: AGENT, target: "isolated" });
    expect(parsed.execution.cwd).toBeUndefined();
  });

  it("keeps M10's stored configs parsing unchanged: a cwd and no agent", () => {
    const parsed = TriggerInput.parse(input({ type: "manual" }, { cwd: "/work/atlas" }));
    expect(parsed.execution.cwd).toBe("/work/atlas");
    expect(parsed.execution.agent).toBeNull();
  });

  it("refuses a cwd and an agent together, and neither of them", () => {
    const both = parse({ type: "manual" }, { cwd: "/work", agent: { agentId: AGENT, target: "isolated" } });
    const neither = parse({ type: "manual" }, {});
    expect(both.success).toBe(false);
    expect(neither.success).toBe(false);
  });

  it("refuses a webhook or a feed whose target is the thread (outside text runs in an isolated task)", () => {
    const thread = { agent: { agentId: AGENT, target: "thread" } };
    expect(parse({ type: "webhook" }, thread).success).toBe(false);
    expect(parse({ type: "feed", url: "https://example.com/feed.xml" }, thread).success).toBe(false);
  });

  it("accepts a webhook or a feed whose target is isolated, and a schedule or a manual one on the thread", () => {
    const isolated = { agent: { agentId: AGENT, target: "isolated" } };
    const thread = { agent: { agentId: AGENT, target: "thread" } };
    expect(parse({ type: "webhook" }, isolated).success).toBe(true);
    expect(parse({ type: "feed", url: "https://example.com/feed.xml" }, isolated).success).toBe(true);
    const schedule = { type: "schedule", rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0", timezone: "Europe/Paris" };
    expect(parse(schedule, thread).success).toBe(true);
    expect(parse({ type: "manual" }, thread).success).toBe(true);
  });

  it("refuses {{precheck}} in a thread-target trigger, keeps it for an isolated one (W5-R32)", () => {
    const schedule = { type: "schedule", rrule: "FREQ=DAILY;BYHOUR=2;BYMINUTE=0", timezone: "Europe/Paris" };
    const withPrecheck = (target: string) =>
      TriggerInput.safeParse({
        name: "Nightly",
        source: schedule,
        execution: { agent: { agentId: AGENT, target }, precheck: "true" },
        prompt: "Look: {{precheck}}",
      });
    expect(withPrecheck("thread").success).toBe(false);
    expect(withPrecheck("isolated").success).toBe(true);
    const plain = TriggerInput.safeParse({
      name: "Nightly",
      source: schedule,
      execution: { agent: { agentId: AGENT, target: "thread" }, precheck: "true" },
      prompt: "Look.",
    });
    expect(plain.success).toBe(true);
  });

  it("refuses an agent id that is not an agent id, and an unknown target", () => {
    expect(parse({ type: "manual" }, { agent: { agentId: "../x", target: "isolated" } }).success).toBe(false);
    expect(parse({ type: "manual" }, { agent: { agentId: AGENT, target: "room" } }).success).toBe(false);
  });
});

describe("the views carry the agent (M11R70)", () => {
  const task = {
    id: "t1",
    triggerId: null,
    triggerName: "Nightly",
    projectId: null,
    state: "queued",
    reason: null,
    origin: "schedule",
    title: "Nightly",
    detail: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    sessionId: null,
    needsInput: false,
    costUsd: 0,
    resetAt: null,
    toolsReleased: false,
  };

  it("TaskView takes agentId and target, together or not at all as M10 rows send them", () => {
    expect(TaskView.parse(task)).toEqual(task);
    expect(TaskView.parse({ ...task, agentId: AGENT, target: "isolated" })).toMatchObject({
      agentId: AGENT,
      target: "isolated",
    });
    expect(TaskView.safeParse({ ...task, agentId: AGENT, target: "elsewhere" }).success).toBe(false);
  });

  it("TaskView takes notBefore and note of a reminder: set, null or absent", () => {
    expect(TaskView.parse({ ...task, notBefore: 1_700_000_000_000, note: "call Bob" })).toMatchObject({
      notBefore: 1_700_000_000_000,
      note: "call Bob",
    });
    expect(TaskView.parse({ ...task, notBefore: null, note: null })).toMatchObject({
      notBefore: null,
      note: null,
    });
    const absent = TaskView.parse(task);
    expect("notBefore" in absent).toBe(false);
    expect("note" in absent).toBe(false);
    expect(TaskView.safeParse({ ...task, notBefore: "soon" }).success).toBe(false);
    expect(TaskView.safeParse({ ...task, note: "x".repeat(201) }).success).toBe(false);
  });

  it("TriggerView takes the agent of an agent trigger", () => {
    const shape = TriggerView.shape;
    expect(Object.keys(shape)).toContain("agent");
    expect(shape.agent.parse({ agentId: AGENT, target: "thread" })).toEqual({
      agentId: AGENT,
      target: "thread",
    });
    expect(shape.agent.parse(null)).toBeNull();
  });
});

describe("automation.fire for an agent trigger (M11R65)", () => {
  it("declares the refusals the thread-target rules answer", () => {
    expect(methods["automation.fire"].errors).toEqual(expect.arrayContaining(["forbidden", "bad_request"]));
  });
});

describe("the board's agent fields (M11R128)", () => {
  const task = {
    id: "t1",
    triggerId: null,
    triggerName: "",
    projectId: null,
    state: "done",
    reason: null,
    origin: "delegate",
    title: "t",
    detail: null,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    sessionId: null,
    needsInput: false,
    costUsd: 0,
    resetAt: null,
    toolsReleased: false,
  };
  const trigger = {
    id: "g1",
    name: "n",
    enabled: true,
    sourceType: "manual",
    projectId: null,
    state: "ok",
    nextFireAt: null,
  };

  it("accepts TaskView.requestedBy when set, null and absent, and refuses a bad id", () => {
    expect(TaskView.parse({ ...task, requestedBy: AGENT }).requestedBy).toBe(AGENT);
    expect(TaskView.parse({ ...task, requestedBy: null }).requestedBy).toBeNull();
    expect(TaskView.parse(task).requestedBy).toBeUndefined();
    expect(TaskView.safeParse({ ...task, requestedBy: "Not An Id" }).success).toBe(false);
  });

  it("accepts TaskTrigger.agentId when set, null and absent, and refuses a bad id", () => {
    expect(TaskTrigger.parse({ ...trigger, agentId: AGENT }).agentId).toBe(AGENT);
    expect(TaskTrigger.parse({ ...trigger, agentId: null }).agentId).toBeNull();
    expect(TaskTrigger.parse(trigger).agentId).toBeUndefined();
    expect(TaskTrigger.safeParse({ ...trigger, agentId: "Not An Id" }).success).toBe(false);
  });
});
