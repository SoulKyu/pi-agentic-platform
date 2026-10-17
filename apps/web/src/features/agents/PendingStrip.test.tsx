// @vitest-environment happy-dom
import type { AgentSummary, TaskView } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { alerts, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { PendingStrip } from "./PendingStrip.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const agent = (id: string, name: string): AgentSummary => ({
  id,
  name,
  initials: name.slice(0, 2).toUpperCase(),
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
});
const task = (id: string, extra: Partial<TaskView>): TaskView => ({
  id,
  triggerId: null,
  triggerName: "",
  projectId: null,
  state: "queued",
  reason: null,
  origin: "delegate",
  title: "t",
  detail: null,
  createdAt: Date.now() - 120_000,
  startedAt: null,
  endedAt: null,
  sessionId: null,
  needsInput: false,
  costUsd: 0,
  resetAt: null,
  toolsReleased: false,
  ...extra,
});
const counts = {
  paused: false,
  slots: 2,
  running: 0,
  queued: 1,
  quietHours: false,
  todayUsd: 0,
  budgetUsd: 5,
};
const load = (tasks: TaskView[]) =>
  act(() => {
    useTasksStore
      .getState()
      .apply({ kind: "snapshot", tasks, truncated: false, triggers: [], failures: [], ...counts });
  });

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  useTasksStore.getState().reset();
  useAgentsStore.getState().reset();
  useAgentsStore.getState().apply({
    kind: "snapshot",
    agents: [agent("atlas-1a2b", "Atlas"), agent("scout-3c4d", "Scout")],
    requests: [],
    truncated: false,
  });
});
const show = async () => {
  const page = await mount(<PendingStrip agentId="atlas-1a2b" />);
  await settle();
  return page;
};

describe("the pending requests strip (M11R121)", () => {
  it("opens the tasks stream with the tab and closes it with it", async () => {
    const page = await show();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    await page.unmount();
    expect(bed.called("unsubscribe")).not.toEqual([]);
  });

  it("draws nothing while this agent has no outgoing work", async () => {
    await load([task("t1", { agentId: "scout-3c4d", requestedBy: "scout-3c4d" })]);
    const page = await show();
    expect(page.container.querySelector("[data-pending-strip]")).toBeNull();
  });

  it("draws the delegations this agent asked for and its queued reminders, and nobody else's", async () => {
    await load([
      task("d1", {
        agentId: "scout-3c4d",
        requestedBy: "atlas-1a2b",
        detail: "check the logs",
        state: "running",
      }),
      task("r1", { origin: "remind", target: "thread", agentId: "atlas-1a2b", title: "Reminder" }),
      task("in", { agentId: "atlas-1a2b", requestedBy: "scout-3c4d", detail: "incoming" }),
      task("rs", { origin: "remind", target: "thread", agentId: "scout-3c4d" }),
      task("done", { agentId: "scout-3c4d", requestedBy: "atlas-1a2b", state: "done", detail: "finished" }),
    ]);
    const page = await show();
    const words = text(page.container);
    expect(words).toContain("delegate → Scout");
    expect(words).toContain("check the logs");
    expect(words).toContain("running");
    expect(words).toContain("Reminder");
    expect(words).not.toContain("incoming");
    expect(words).not.toContain("finished");
    expect(page.container.querySelectorAll("[data-pending-row]")).toHaveLength(2);
  });

  it("shows a reminder with its local time and its note as text", async () => {
    const at = new Date(2026, 9, 16, 16, 5).getTime();
    await load([
      task("r1", {
        origin: "remind",
        target: "thread",
        agentId: "atlas-1a2b",
        title: "Reminder",
        notBefore: at,
        note: "<i>call</i>\u202e Bob",
      }),
    ]);
    const page = await show();
    const words = text(page.container);
    expect(words).toContain(
      `remind ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(at)}`,
    );
    expect(words).toContain("«<i>call</i> Bob»");
    expect(page.container.querySelector("i")).toBeNull();
  });

  it("keeps the old reminder row (no time, no note) readable", async () => {
    await load([
      task("r1", { origin: "remind", target: "thread", agentId: "atlas-1a2b", title: "Reminder" }),
    ]);
    const page = await show();
    expect(text(page.container)).toContain("Reminder");
  });

  it("shows ten rows and counts the rest", async () => {
    await load(
      Array.from({ length: 13 }, (_, n) =>
        task(`d${n}`, {
          agentId: "scout-3c4d",
          requestedBy: "atlas-1a2b",
          detail: `job ${n}`,
          createdAt: Date.now() - n,
        }),
      ),
    );
    const page = await show();
    expect(page.container.querySelectorAll("[data-pending-row]")).toHaveLength(10);
    expect(text(page.container)).toContain("and 3 more");
  });

  it("shows how long a delegation has waited", async () => {
    await load([task("d1", { agentId: "scout-3c4d", requestedBy: "atlas-1a2b", detail: "x" })]);
    const page = await show();
    expect(text(page.container)).toContain("queued 2 min");
  });

  it("shows the agent's words as text with hidden characters removed", async () => {
    await load([
      task("d1", { agentId: "scout-3c4d", requestedBy: "atlas-1a2b", detail: "<b>x</b>\u202e y" }),
    ]);
    const page = await show();
    expect(text(page.container)).toContain("<b>x</b> y");
    expect(page.container.querySelector("b")).toBeNull();
  });

  it("cancels with M10's method and the row's task id", async () => {
    bed.handlers["automation.tasks.cancel"] = () => ({ taskId: "d1" });
    await load([task("d1", { agentId: "scout-3c4d", requestedBy: "atlas-1a2b", detail: "x" })]);
    const page = await show();
    await click(button(page.container, "Cancel"));
    await settle();
    expect(bed.called("automation.tasks.cancel")).toEqual([
      expect.objectContaining({ params: { taskId: "d1" } }),
    ]);
  });

  it("says why a cancel failed, in words", async () => {
    bed.handlers["automation.tasks.cancel"] = () => {
      throw new RpcError("conflict");
    };
    await load([task("d1", { agentId: "scout-3c4d", requestedBy: "atlas-1a2b", detail: "x" })]);
    const page = await show();
    await click(button(page.container, "Cancel"));
    await settle();
    expect(alerts(page.container)).not.toEqual([]);
    expect(hasButton(page.container, "Cancel")).toBe(true);
  });
});
