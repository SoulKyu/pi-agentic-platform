// @vitest-environment happy-dom
import type { AgentStatus, AgentSummary } from "@pap/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { mount, settle } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { PendingStrip } from "./PendingStrip.tsx";
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
const status: AgentStatus = {
  today: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
  days7Usd: 0,
  days30Usd: 0,
  billing: "api",
  tasks: [],
  triggers: [],
  truncated: false,
};

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.status"] = () => status;
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
  useAgentsStore.getState().apply({ kind: "snapshot", agents: [atlas], requests: [], truncated: false });
});

describe("the status panel and the pending strip open together", () => {
  it("share one tasks subscription, and closing both closes it, leaving no stream behind", async () => {
    const page = await mount(
      <>
        <PendingStrip agentId={ID} />
        <StatusPanel
          agentId={ID}
          layout="side"
          onOpenSettings={vi.fn()}
          onOpenSession={vi.fn()}
          onOpenTrigger={vi.fn()}
          onNewTrigger={vi.fn()}
        />
      </>,
    );
    await settle();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    expect(bed.called("unsubscribe")).toEqual([]);
    await page.unmount();
    await settle();
    expect(bed.called("unsubscribe")).toHaveLength(1);
  });
});
