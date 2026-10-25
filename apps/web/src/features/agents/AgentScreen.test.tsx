// @vitest-environment happy-dom
import { AgentInput, type AgentRequestView, type AgentSummary, type AgentView } from "@pap/contracts";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useSecretDialog } from "../../stores/secret-dialog-store.ts";
import { DEFAULT_SESSION_POLICY_VIEW } from "@pap/contracts";
import { EMPTY_VIEW } from "../../stores/session-reducer.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { statuses, button, click, hasButton, mount, settle, text } from "../../testing/dom.ts";
import { isDisabled, menuItem, menuLabels, openMenu, preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import type { Interleave } from "../../stores/thread-interleave.ts";
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
  unread: 2,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: "s1",
  lastActivityAt: 1,
};
const view = (patch: Partial<AgentView> = {}): AgentView => ({
  id: "atlas-1a2b",
  name: "Atlas",
  input: AgentInput.parse({
    name: "Atlas",
    role: "Keeps the repository tidy.\nSecond line of the role.",
    model: { provider: "anthropic", modelId: "sonnet" },
  }),
  state: "active",
  threadSessionId: "s1",
  unread: 2,
  paused: false,
  quarantinedAt: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
  ...patch,
});
const approval: AgentRequestView = {
  id: "r1",
  agentId: "atlas-1a2b",
  kind: "approve",
  title: "Deploy the site?",
  detail: "Ships v2",
  createdAt: Date.now(),
  expiresAt: Date.now() + 20 * 60_000,
};

let bed: ReturnType<typeof fakeRuntime>;
let slot: ThreadSlot | null = null;
const arranged: { current: ReturnType<Interleave["arrange"]> | null } = { current: null };

/** The shell's thread renderer, reduced to what the screen hands it. */
const thread = (given: ThreadSlot) => {
  slot = given;
  arranged.current = given.interleave.arrange(
    [{ key: "m1", at: Date.UTC(2026, 9, 15, 9, 0), author: "agent", text: "hi" }],
    false,
  );
  return (
    <div data-thread={given.sessionId}>
      {given.header}
      <div data-after>{arranged.current.after}</div>
      {given.beforeComposer}
    </div>
  );
};

beforeEach(async () => {
  slot = null;
  arranged.current = null;
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.openThread"] = () => ({ sessionId: "s1" });
  bed.handlers["agents.get"] = () => view();
  bed.handlers["agents.events"] = () => ({ events: [], more: false, next: null });
  bed.handlers["agents.markRead"] = () => ({});
  bed.handlers["agents.prompts"] = () => ({ names: [] });
  useAgentsStore.getState().reset();
  useSessionStore.setState({ views: {} });
  await preloadMenu();
});
afterEach(() => {
  vi.useRealTimers();
});

const load = (agents: readonly AgentSummary[], requests: readonly AgentRequestView[] = []) =>
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents, requests, truncated: false });
  });
const show = async (props: { onOpenSettings?: () => void; eventCards?: "cards" | "compact" } = {}) => {
  const onOpenSettings = props.onOpenSettings ?? vi.fn();
  const page = await mount(
    <AgentScreen
      agentId="atlas-1a2b"
      avatarStyle="outlined"
      eventCards={props.eventCards ?? "cards"}
      statusPanel="hidden"
      thread={thread}
      onOpenSettings={onOpenSettings}
      onOpenSession={() => {}}
      onOpenTrigger={() => {}}
    />,
  );
  await settle();
  return { page, onOpenSettings };
};

describe("the agent screen opens the thread (M11R118)", () => {
  it("calls agents.openThread once and gives the session to the thread", async () => {
    await load([atlas]);
    const { page } = await show();
    expect(bed.called("agents.openThread")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b" } }),
    ]);
    expect(page.container.querySelector("[data-thread]")?.getAttribute("data-thread")).toBe("s1");
    expect(slot?.sessionId).toBe("s1");
  });

  it("waits for the agents stream, then says so when the agent is gone", async () => {
    const { page } = await show();
    expect(text(page.container)).toContain("Loading agent");
    await load([]);
    expect(text(page.container)).toContain("This agent no longer exists.");
  });

  it("shows the sandbox refusal as the error copy with a link to Settings › Agents, header kept", async () => {
    bed.handlers["agents.openThread"] = () => {
      throw new RpcError("sandbox_unavailable");
    };
    await load([atlas]);
    const { page, onOpenSettings } = await show();
    expect(statuses(page.container).join(" ")).toContain("Agents run in microVMs");
    expect(text(page.container)).not.toContain("external content");
    expect(page.container.querySelector("[data-thread]")).toBeNull();
    expect(hasButton(page.container, "Queue task")).toBe(true);
    await click(button(page.container, "Open Settings › Agents"));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("offers a retry for another refusal and no Settings link", async () => {
    bed.handlers["agents.openThread"] = () => {
      throw new RpcError("capacity");
    };
    await load([atlas]);
    const { page } = await show();
    expect(page.container.querySelector('[data-slot="inline-error"][role="status"]')).not.toBeNull();
    expect(hasButton(page.container, "Open Settings › Agents")).toBe(false);
    expect(hasButton(page.container, "Try again")).toBe(true);
  });
});

describe("the agent header (decision 85: every action visible or in the menu)", () => {
  it("shows the avatar, name, the role's first line, the model and the state", async () => {
    await load([atlas]);
    const { page } = await show();
    const words = text(page.container);
    expect(words).toContain("Atlas");
    expect(words).toContain("Keeps the repository tidy.");
    expect(words).not.toContain("Second line of the role.");
    expect(words).toContain("anthropic / sonnet");
    expect(words).not.toMatch(/idle|ready/i); // a ready agent is the default: no badge
  });

  it("has Queue task, Pause and a menu with Reset thread, Settings, Quarantine and Delete", async () => {
    await load([atlas]);
    const { page } = await show();
    expect(hasButton(page.container, "Queue task")).toBe(true);
    expect(hasButton(page.container, "Pause")).toBe(true);
    await openMenu(button(page.container, "More actions"));
    expect(menuLabels()).toEqual(["Reset thread", "Settings", "Quarantine", "Delete"]);
  });

  it("pauses the agent, and offers Resume while it is paused", async () => {
    bed.handlers["agents.setPaused"] = () => view({ paused: true });
    await load([atlas]);
    const { page } = await show();
    await click(button(page.container, "Pause"));
    await settle();
    expect(bed.called("agents.setPaused")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b", paused: true } }),
    ]);
    await load([{ ...atlas, paused: true, state: "paused" }]);
    expect(hasButton(page.container, "Resume")).toBe(true);
    expect(hasButton(page.container, "Pause")).toBe(false);
  });

  it("resets the thread after a confirmation, then opens the next one", async () => {
    bed.handlers["agents.resetThread"] = () => ({});
    await load([atlas]);
    const { page } = await show();
    await openMenu(button(page.container, "More actions"));
    await click(menuItem("Reset thread"));
    expect(bed.called("agents.resetThread")).toEqual([]);
    await click(button(page.container, "Reset thread"));
    await settle();
    expect(bed.called("agents.resetThread")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b" } }),
    ]);
    expect(bed.called("agents.openThread")).toHaveLength(2);
  });

  it("disables Pause and Quarantine's neighbours for a quarantined agent but keeps Settings", async () => {
    await load([{ ...atlas, state: "quarantined", quarantined: true, paused: true }]);
    const { page } = await show();
    expect(button(page.container, "Resume").disabled).toBe(true);
    await openMenu(button(page.container, "More actions"));
    expect(isDisabled(menuItem("Reset thread"))).toBe(true);
    expect(isDisabled(menuItem("Settings"))).toBe(false);
  });

  it("shows the dashed external content chip only while the thread is tainted (W5-R38)", async () => {
    await load([atlas]);
    const { page } = await show();
    expect(text(page.container)).not.toContain("external content");
    act(() => {
      useSessionStore.setState({
        views: { s1: { ...EMPTY_VIEW, policy: { ...DEFAULT_SESSION_POLICY_VIEW, tainted: true } } },
      });
    });
    expect(text(page.container)).toContain("external content");
    act(() => {
      useSessionStore.setState({
        views: { s1: { ...EMPTY_VIEW, policy: { ...DEFAULT_SESSION_POLICY_VIEW, tainted: false } } },
      });
    });
    expect(text(page.container)).not.toContain("external content");
  });
});

describe("the thread's cards and requests", () => {
  it("places the agent's event cards through the interleave it hands to the thread", async () => {
    bed.handlers["agents.events"] = () => ({
      events: [
        {
          id: 4,
          kind: "notify",
          at: Date.UTC(2026, 9, 15, 10, 0),
          taskId: null,
          data: { text: "Build done", itemId: "i" },
        },
      ],
      more: false,
      next: null,
    });
    await load([atlas]);
    const { page } = await show();
    expect(text(page.container.querySelector("[data-after]") as HTMLElement)).toContain("Build done");
  });

  it("reads the cards again when the stream says one was written", async () => {
    await load([atlas]);
    await show();
    expect(bed.called("agents.events")).toHaveLength(1);
    act(() => {
      useAgentsStore.getState().apply({ kind: "event", agentId: "atlas-1a2b", eventId: 9 });
    });
    await settle();
    expect(bed.called("agents.events")).toHaveLength(2);
  });

  it("pins this agent's requests above the composer, and only its own", async () => {
    await load([atlas], [approval, { ...approval, id: "r2", agentId: "other-9a9b", title: "Not yours" }]);
    const { page } = await show();
    expect(text(page.container)).toContain("Atlas asks: Deploy the site?");
    expect(text(page.container)).not.toContain("Not yours");
  });

  it("wires Provide… of a secret request to the secret dialog (Task 27)", async () => {
    await load([atlas], [{ ...approval, id: "r9", kind: "secret", title: "GITHUB_TOKEN", detail: null }]);
    const { page } = await show();
    await click(button(page.container, "Provide…"));
    expect(useSecretDialog.getState().requestId).toBe("r9");
    useSecretDialog.getState().close();
  });
});

describe("marking the thread read (pi-web's rule: 1 s of visibility)", () => {
  it("calls agents.markRead after the thread has been in view for a second, not before", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await load([atlas]);
    await mount(
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(slot?.sessionId).toBe("s1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(bed.called("agents.markRead")).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(bed.called("agents.markRead")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b" } }),
    ]);
  });

  it("does not call it for an agent with nothing unread", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    await load([{ ...atlas, unread: 0 }]);
    await mount(
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(bed.called("agents.markRead")).toEqual([]);
  });

  it("waits while the page is hidden", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const hidden = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await load([atlas]);
    await mount(
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
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(bed.called("agents.markRead")).toEqual([]);
    hidden.mockRestore();
  });
});

describe("the Files tab (sub-project 2)", () => {
  const vm = { usable: true, reason: null, vmdVersion: "1", claudeToken: "set", agents: [] };

  it("is offered and shows the agent's files", async () => {
    bed.handlers["agents.vmStatus"] = () => vm;
    bed.handlers["agents.files.list"] = () => ({ files: [] });
    await load([atlas]);
    const { page } = await show();
    await click(button(page.container, "Files"));
    await settle();
    expect(bed.called("agents.files.list")).toEqual([
      expect.objectContaining({ params: { agentId: "atlas-1a2b" } }),
    ]);
    expect(text(page.container)).toContain("No file yet");
  });
});
