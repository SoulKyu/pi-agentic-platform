// @vitest-environment happy-dom
import type { AgentStatus, AgentSummary, TriggerView } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
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
const trigger = (id: string, enabled: boolean, type: "manual" | "schedule"): TriggerView =>
  ({
    id,
    name: id,
    enabled,
    state: "ok",
    source:
      type === "manual"
        ? { type }
        : { type, rrule: "FREQ=DAILY;BYHOUR=2", timezone: "Europe/Paris", catchUp: "skip" },
    execution: null,
    prompt: null,
    projectId: null,
    cwd: "/x",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    webhookUrl: null,
    secretRotatedAt: null,
    nextFireAt: null,
    lastFireAt: null,
    redacted: false,
  }) as TriggerView;
const status = (triggers: readonly TriggerView[]): AgentStatus => ({
  today: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
  days7Usd: 0,
  days30Usd: 0,
  billing: "api",
  tasks: [],
  triggers: [...triggers],
  truncated: false,
});

const fire = vi.fn();
const panel = async (triggers: readonly TriggerView[]) => {
  bed.handlers["agents.status"] = () => status(triggers);
  bed.handlers["automation.fire"] = fire;
  const page = await mount(
    <StatusPanel
      agentId={ID}
      layout="side"
      onOpenSettings={vi.fn()}
      onOpenSession={vi.fn()}
      onOpenTrigger={vi.fn()}
      onNewTrigger={vi.fn()}
    />,
  );
  await act(async () => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [atlas], requests: [], truncated: false });
  });
  await settle();
  return page;
};

let bed: ReturnType<typeof fakeRuntime>;
beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  fire.mockReset();
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
});

describe("the trigger run button", () => {
  it("shows for an enabled trigger of any source and not for a disabled one", async () => {
    const page = await panel([trigger("nightly", true, "schedule"), trigger("paused", false, "manual")]);
    expect(hasButton(page.container, "Run nightly")).toBe(true);
    expect(hasButton(page.container, "Run paused")).toBe(false);
  });

  it("fires the trigger and says so", async () => {
    fire.mockReturnValue({ verdict: "fired", taskId: "t1" });
    const page = await panel([trigger("nightly", true, "schedule")]);
    await click(button(page.container, "Run nightly"));
    await settle();
    expect(fire).toHaveBeenCalledWith({ triggerId: "nightly" });
    expect(text(page.container)).toContain("Trigger fired.");
  });

  it("shows the precheck's detail when the fire is skipped", async () => {
    fire.mockReturnValue({ verdict: "precheck", detail: "exit_1" });
    const page = await panel([trigger("nightly", true, "schedule")]);
    await click(button(page.container, "Run nightly"));
    await settle();
    expect(text(page.container)).toContain("Skipped: exit_1");
  });

  it("tells a failed verdict and an RPC error, and the next fire clears the message", async () => {
    fire.mockReturnValueOnce({ verdict: "error", detail: "x" });
    const page = await panel([trigger("nightly", true, "schedule")]);
    await click(button(page.container, "Run nightly"));
    await settle();
    expect(text(page.container)).toContain("Fire failed.");
    fire.mockImplementationOnce(() => {
      throw new RpcError("automation_paused");
    });
    await click(button(page.container, "Run nightly"));
    await settle();
    expect(text(page.container)).not.toContain("Fire failed.");
    expect(page.container.querySelector("[role=alert]")).not.toBeNull();
  });
});
