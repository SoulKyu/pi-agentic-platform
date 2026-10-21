// @vitest-environment happy-dom
import type { AgentSummary } from "@pap/contracts";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentScreen, type ThreadSlot } from "./AgentScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const atlas: AgentSummary = {
  id: "atlas-1a2b",
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

let bed: ReturnType<typeof fakeRuntime>;
const thread = (given: ThreadSlot) => (
  <div data-thread={given.sessionId}>
    {given.header}
    {given.beforeComposer}
  </div>
);

beforeEach(() => {
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.openThread"] = () => ({ sessionId: "s1" });
  bed.handlers["agents.get"] = () => {
    throw new Error("not read here");
  };
  bed.handlers["agents.events"] = () => ({ events: [], more: false, next: null });
  bed.handlers["agents.markRead"] = () => ({});
  bed.handlers["agents.prompts"] = () => ({ names: [] });
  useAgentsStore.getState().reset();
  useSessionStore.setState({ views: {} });
});

const load = (agents: readonly AgentSummary[]) =>
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents, requests: [], truncated: false });
  });
const show = async () => {
  const page = await mount(
    <AgentScreen
      agentId="atlas-1a2b"
      avatarStyle="outlined"
      eventCards="cards"
      statusPanel="hidden"
      thread={thread}
      onOpenSettings={() => {}}
      onOpenSession={() => {}}
      onOpenTrigger={() => {}}
    />,
  );
  await settle();
  return { page };
};

describe("one lifecycle for the header pill and the chip above the composer", () => {
  const vm = (phase: "running" | "stopped" | "starting" | "paused") =>
    (bed.handlers["agents.vmStatus"] = () => ({
      runtime: "vm",
      usable: true,
      reason: null,
      vmdVersion: "1.0.0",
      claudeToken: "set",
      agents: [{ id: "atlas-1a2b", phase }],
    }));
  const session = (status: "cold" | "starting" | "idle" | "running") =>
    useSessionStore.setState({ views: { s1: { ...EMPTY_VIEW, status } } });
  const chips = (container: HTMLElement) =>
    [...container.querySelectorAll("[data-lifecycle]")].map((chip) => [
      chip.getAttribute("data-lifecycle"),
      chip.closest("[data-composer-lifecycle]") === null ? "header" : "composer",
    ]);

  it("says nothing for a ready agent", async () => {
    vm("running");
    session("idle");
    await load([atlas]);
    const { page } = await show();
    expect(chips(page.container)).toEqual([]);
  });

  it("parks a healthy agent whose VM stopped after a run: the header says it, the composer stays quiet", async () => {
    vm("stopped");
    session("cold");
    await load([atlas]);
    const { page } = await show();
    expect(chips(page.container)).toEqual([["parked", "header"]]);
    expect(text(page.container)).not.toMatch(/stopped/i);
  });

  it("wakes: the pill and the composer chip say the same word while the VM starts", async () => {
    vm("starting");
    session("cold");
    await load([atlas]);
    const { page } = await show();
    expect(chips(page.container)).toEqual([
      ["waking", "header"],
      ["waking", "composer"],
    ]);
  });

  it("needs input: the pill and the composer chip", async () => {
    vm("running");
    await load([{ ...atlas, state: "needs_input" }]);
    const { page } = await show();
    expect(chips(page.container)).toEqual([
      ["needs_input", "header"],
      ["needs_input", "composer"],
    ]);
  });

  it("paused by the owner: the pill and the composer chip", async () => {
    await load([{ ...atlas, state: "paused", paused: true }]);
    const { page } = await show();
    expect(chips(page.container)).toEqual([
      ["paused", "header"],
      ["paused", "composer"],
    ]);
  });

  it("working shows in the header only", async () => {
    session("running");
    await load([atlas]);
    const { page } = await show();
    expect(chips(page.container)).toEqual([["working", "header"]]);
  });
});
