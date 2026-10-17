// @vitest-environment happy-dom
import { AgentInput, type AgentSummary, type AgentView } from "@pap/contracts";
import { act, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useComposerPrefill } from "../../stores/composer-prefill.ts";
import { useHandOffPorts } from "../../stores/composer-hand-off.ts";
import { EMPTY_VIEW, type SessionView } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { useTasksStore } from "../../stores/tasks-store.ts";
import { button, click, field, mount, settle, text } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentScreen, type ThreadSlot } from "./AgentScreen.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
const toasts = vi.hoisted(() => ({ shown: [] as Array<{ message: string; action?: { run(): void } }> }));
vi.mock("@pap/ui", async (original) => ({
  ...(await original<typeof import("@pap/ui")>()),
  toast: (input: { message: string; action?: { run(): void } }) => {
    toasts.shown.push(input);
    return "t";
  },
}));

const summary = (id: string, name: string, extra: Partial<AgentSummary> = {}): AgentSummary => ({
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
  ...extra,
});
const detail: AgentView = {
  id: "atlas-1a2b",
  name: "Atlas",
  input: AgentInput.parse({ name: "Atlas", role: "r", model: { provider: "anthropic", modelId: "sonnet" } }),
  state: "active",
  threadSessionId: "s1",
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

let bed: ReturnType<typeof fakeRuntime>;
const thread = (slot: ThreadSlot): ReactNode => (
  <div data-thread={slot.sessionId}>
    {slot.header}
    {slot.beforeComposer}
  </div>
);
beforeEach(() => {
  toasts.shown = [];
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.openThread"] = () => ({ sessionId: "s1" });
  bed.handlers["agents.get"] = () => detail;
  bed.handlers["agents.events"] = () => ({ events: [], more: false, next: null });
  bed.handlers["agents.markRead"] = () => ({});
  bed.handlers["agents.prompts"] = () => ({ names: ["triage"] });
  bed.handlers["agents.queueTask"] = () => ({ taskId: "queued-1" });
  bed.handlers["automation.tasks.cancel"] = () => ({ taskId: "queued-1" });
  useAgentsStore.getState().reset();
  useTasksStore.getState().reset();
  useSessionStore.setState({ views: {} });
  useHandOffPorts.setState({ ports: {} });
  useComposerPrefill.setState({ items: {} });
});
const messages = (...rows: Array<[string, string]>): SessionView =>
  ({
    ...EMPTY_VIEW,
    messages: rows.map(([role, body], index) => ({ key: `m${index}`, role, text: body })),
  }) as unknown as SessionView;
const show = async (agents = [summary("atlas-1a2b", "Atlas"), summary("scout-3c4d", "Scout")]) => {
  act(() => useAgentsStore.getState().apply({ kind: "snapshot", agents, requests: [], truncated: false }));
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
  return page;
};
const port = () => useHandOffPorts.getState().ports["s1"];

describe("Queue task in the header (carry 1)", () => {
  it("is enabled and opens the dialog", async () => {
    const page = await show();
    const queue = button(page.container, "Queue task");
    expect(queue.disabled).toBe(false);
    await click(queue);
    expect(field(document.body, "Prompt")).toBeTruthy();
  });
});

describe("the composer's @Name hand-off (M11R123)", () => {
  it("lists only the other agents' names for the composer's menu", async () => {
    await show();
    expect(port()?.names).toEqual(["Scout"]);
  });

  it("queues the text for Scout with the thread's last assistant message as the quote", async () => {
    useSessionStore.setState({
      views: { s1: messages(["assistant", "old"], ["user", "q"], ["assistant", "the plan"]) },
    });
    await show();
    expect(port()?.handOff("@Scout do it")).toBe(true);
    await settle();
    expect(bed.called("agents.queueTask")).toEqual([
      expect.objectContaining({
        params: {
          agentId: "scout-3c4d",
          prompt: "do it",
          handOff: { fromAgentId: "atlas-1a2b", quote: "the plan" },
        },
      }),
    ]);
    expect(bed.called("sessions.prompt")).toEqual([]);
  });

  it("leaves the hand-off object out when the thread has no assistant message yet", async () => {
    await show();
    port()?.handOff("@Scout do it");
    await settle();
    expect(bed.called("agents.queueTask")[0]?.params).toEqual({ agentId: "scout-3c4d", prompt: "do it" });
  });

  it("is not a hand-off for a plain message, another case or the agent itself", async () => {
    await show();
    expect(port()?.handOff("hello")).toBe(false);
    expect(port()?.handOff("@scout do it")).toBe(false);
    expect(port()?.handOff("@Atlas do it")).toBe(false);
    expect(port()?.handOff("@Scout")).toBe(false);
    expect(bed.called("agents.queueTask")).toEqual([]);
  });

  it("toasts `Queued for Scout` and Undo cancels the queued task", async () => {
    await show();
    port()?.handOff("@Scout do it");
    await settle();
    expect(toasts.shown[0]?.message).toBe("Queued for Scout");
    toasts.shown[0]?.action?.run();
    await settle();
    expect(bed.called("automation.tasks.cancel")).toEqual([
      expect.objectContaining({ params: { taskId: "queued-1" } }),
    ]);
  });

  it("says `runs when resumed` when the target agent is paused", async () => {
    await show([summary("atlas-1a2b", "Atlas"), summary("scout-3c4d", "Scout", { paused: true })]);
    port()?.handOff("@Scout do it");
    await settle();
    expect(toasts.shown[0]?.message).toBe("Queued for Scout, runs when resumed");
  });

  it("does not hand the text back when the outcome is unknown: it says to check the tasks board", async () => {
    bed.handlers["agents.queueTask"] = () => {
      throw new RpcError("connection_lost");
    };
    await show();
    expect(port()?.handOff("@Scout do it")).toBe(true);
    await settle();
    expect(useComposerPrefill.getState().items["s1"]).toBeUndefined();
    expect(toasts.shown.at(-1)?.message).toBe("Not sure it was queued: check the tasks board");
    expect(bed.called("agents.queueTask")).toHaveLength(1);
  });

  it("treats a timeout the same way", async () => {
    bed.handlers["agents.queueTask"] = () => {
      throw new RpcError("timeout");
    };
    await show();
    port()?.handOff("@Scout do it");
    await settle();
    expect(useComposerPrefill.getState().items["s1"]).toBeUndefined();
    expect(toasts.shown.at(-1)?.message).toBe("Not sure it was queued: check the tasks board");
  });

  it("gives the text back to the composer when the daemon refuses", async () => {
    bed.handlers["agents.queueTask"] = () => {
      throw new RpcError("forbidden");
    };
    await show();
    expect(port()?.handOff("@Scout do it")).toBe(true);
    await settle();
    expect(useComposerPrefill.getState().items["s1"]?.text).toBe("@Scout do it");
    expect(toasts.shown.at(-1)?.message).not.toBe("Queued for Scout");
  });

  it("takes the port away with the tab", async () => {
    const page = await show();
    await page.unmount();
    expect(port()).toBeUndefined();
  });
});

describe("the prompt chips and the strip are in the tab (M11R121, M11R122)", () => {
  it("fills the thread's composer from a chip and sends nothing", async () => {
    bed.handlers["agents.prompt"] = () => ({ text: "triage the inbox" });
    const page = await show();
    await click(button(page.container, "triage"));
    await settle();
    expect(useComposerPrefill.getState().items["s1"]?.text).toBe("triage the inbox");
    expect(bed.called("sessions.prompt")).toEqual([]);
  });

  it("opens the tasks stream with the tab", async () => {
    await show();
    expect(bed.called("subscribe.tasks")).toHaveLength(1);
    expect(text(document.body)).not.toContain("delegate →");
  });
});
