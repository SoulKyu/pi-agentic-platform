// @vitest-environment happy-dom
import type { AgentStatus, AgentSummary, TaskView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { StatusPanel } from "./StatusPanel.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const ID = "atlas-1a2b";
const atlas: AgentSummary = {
  id: ID,
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
};
const status = (days7Usd = 2.4): AgentStatus => ({
  today: { usd: 1.2, tokens: 12_400, budgetUsd: null, budgetTokens: null },
  days7Usd,
  days30Usd: 9,
  billing: "api",
  tasks: [],
  triggers: [],
  truncated: false,
});
const task: TaskView = {
  id: "t1",
  triggerId: null,
  triggerName: "",
  projectId: null,
  state: "running",
  reason: null,
  origin: "agent",
  title: "Tidy the repo",
  detail: null,
  createdAt: 1,
  startedAt: 2,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  agentId: ID,
};
const tasksSnapshot = (tasks: readonly TaskView[]) => ({
  kind: "snapshot",
  paused: false,
  slots: 2,
  running: 0,
  queued: 0,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: 5,
  tasks,
  truncated: false,
  triggers: [],
  failures: [],
});

const FAKE = {
  toFake: ["setTimeout" as const, "clearTimeout" as const, "setInterval" as const, "clearInterval" as const],
};
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.status"] = () => status();
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
  useAgentsStore.getState().apply({ kind: "snapshot", agents: [atlas], requests: [], truncated: false });
});
afterEach(() => vi.useRealTimers());
const panel = () =>
  mount(
    <StatusPanel
      agentId={ID}
      layout="side"
      onOpenSettings={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenTrigger={vi.fn()}
      onNewTrigger={vi.fn()}
    />,
  );

describe("the first tasks snapshot", () => {
  it("does not cause a second agents.status read, but a later task event does", async () => {
    vi.useFakeTimers(FAKE);
    await panel();
    await advance(0);
    expect(bed.called("agents.status")).toHaveLength(1);
    act(() => {
      useTasksStore.getState().apply(tasksSnapshot([task]));
    });
    await advance(5000);
    expect(bed.called("agents.status")).toHaveLength(1);
    act(() => {
      useTasksStore.getState().apply({ kind: "task", previous: null, task: { ...task, state: "done" } });
    });
    await advance(1000);
    expect(bed.called("agents.status")).toHaveLength(2);
  });

  it("does not cause one either when the store was already loaded", async () => {
    vi.useFakeTimers(FAKE);
    useTasksStore.getState().apply(tasksSnapshot([task]));
    await panel();
    await advance(5000);
    expect(bed.called("agents.status")).toHaveLength(1);
  });
});

describe("a refetch that fails", () => {
  it("keeps the figures already shown and adds a notice with Try again", async () => {
    vi.useFakeTimers(FAKE);
    const page = await panel();
    await advance(0);
    expect(text(page.container)).toContain("$2.40");
    bed.handlers["agents.status"] = () => {
      throw new RpcError("internal");
    };
    act(() => {
      useAgentsStore.getState().apply({ kind: "event", agentId: ID, eventId: 1 });
    });
    await advance(1000);
    expect(text(page.container)).toContain("$2.40");
    expect(text(page.container)).toContain(
      "The status could not be refreshed. These are the last figures read.",
    );
    bed.handlers["agents.status"] = () => status(3.5);
    await click(button(page.container, "Try again"));
    await advance(0);
    expect(text(page.container)).toContain("$3.50");
    expect(text(page.container)).not.toContain("could not be refreshed");
  });

  it("shows the empty failed state only for a first read that failed", async () => {
    bed.handlers["agents.status"] = () => {
      throw new RpcError("internal");
    };
    const page = await panel();
    await settle();
    expect(text(page.container)).toContain("The status could not be read.");
    expect(text(page.container)).not.toContain("last figures");
    expect(text(page.container)).not.toContain("$");
  });
});
