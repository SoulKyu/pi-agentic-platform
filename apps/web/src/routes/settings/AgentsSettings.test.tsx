// @vitest-environment happy-dom
import { AgentInput, type AgentSummary, type AgentView } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { StepUpContext, type StepUpRunner } from "../../lib/step-up-context.tsx";
import { RpcError, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { alerts, button, click, field, hasButton, mount, settle, text, typeInto } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { AgentsSettings } from "./AgentsSettings.tsx";

vi.mock("../../runtime/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const current: { runtime: Runtime | undefined } = { runtime: undefined };

const summary = (id: string, name: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
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
  ...patch,
});
const full = (id: string, name: string, revision = 1, patch: Record<string, unknown> = {}): AgentView => ({
  id,
  name,
  input: AgentInput.parse({ name, ...patch }),
  state: "active",
  threadSessionId: null,
  unread: 0,
  paused: false,
  quarantinedAt: null,
  revision,
  createdAt: 1,
  updatedAt: 2,
});
const snapshot = (agents: AgentSummary[]) =>
  useAgentsStore.getState().apply({ kind: "snapshot", agents, requests: [], truncated: false });

async function open(agents: AgentSummary[] | null = [], views: Record<string, AgentView> = {}) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["models.overview"] = () => ({ providers: [], truncated: false });
  bed.handlers["agents.get"] = (params) => {
    const found = views[(params as { agentId: string }).agentId];
    if (!found) throw new RpcError("not_found");
    return found;
  };
  if (agents !== null) snapshot(agents);
  const page = await mount(
    <TooltipProvider>
      <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
        <AgentsSettings />
      </StepUpContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  return { bed, page };
}
const body = () => text(document.body);

beforeEach(() => {
  setLocale("en");
  useAgentsStore.getState().reset();
});

describe("Settings › Agents: the list", () => {
  it("says it is loading until the stream's first snapshot", async () => {
    await open(null);
    expect(body()).toContain("Loading agents…");
    expect(body()).not.toContain("No agent yet.");
    snapshot([]);
    await settle();
    expect(body()).toContain("No agent yet.");
  });

  it("lists each agent with its state and an Open button, and New agent", async () => {
    await open([
      summary("atlas-1a2b", "atlas", { state: "running" }),
      summary("scout-2b2b", "scout", { state: "needs_input" }),
      summary("rex-3c3c", "rex", { state: "quarantined", quarantined: true }),
    ]);
    expect(body()).toContain("atlas");
    expect(body()).toContain("working");
    expect(body()).toContain("needs input");
    expect(body()).toContain("quarantined");
    expect(hasButton(document.body, "Open atlas")).toBe(true);
    expect(hasButton(document.body, "Open scout")).toBe(true);
    expect(hasButton(document.body, "New agent")).toBe(true);
  });

  it("says there is no agent yet, and still offers New agent", async () => {
    await open([]);
    expect(body()).toContain("No agent yet.");
    expect(hasButton(document.body, "New agent")).toBe(true);
  });

  it("says the stream was refused", async () => {
    await open(null);
    useAgentsStore.getState().fail("forbidden");
    await settle();
    expect(body()).toContain("The agents list could not be read.");
  });

  it("reads the VM status once under the list, not through a second subscription", async () => {
    const { bed } = await open([summary("atlas-1a2b", "atlas")]);
    expect(bed.called("agents.vmStatus")).toHaveLength(1);
    expect(bed.called("subscribe.agents")).toEqual([]);
    expect(bed.called("agents.list")).toEqual([]);
  });
});

describe("Settings › Agents: New agent (M11R96 entry point)", () => {
  it("opens the dialog, and opens the new agent's settings once it is created", async () => {
    const created = full("nova-9d9d", "nova");
    const { bed } = await open([]);
    bed.handlers["agents.create"] = () => created;
    bed.handlers["agents.get"] = () => created;
    await click(button(document.body, "New agent"));
    await typeInto(field(document.body, "Name"), "nova");
    await click(button(document.body, "Create agent"));
    await settle();
    expect(bed.called("agents.create")).toHaveLength(1);
    expect(hasButton(document.body, "All agents")).toBe(true);
    expect(bed.called("agents.get")).toHaveLength(1);
  });
});

describe("Settings › Agents: one agent", () => {
  const atlas = summary("atlas-1a2b", "atlas");

  it("opens the form with the saved values and goes back to the list", async () => {
    await open([atlas], { "atlas-1a2b": full("atlas-1a2b", "atlas", 2, { role: "Reviews diffs" }) });
    await click(button(document.body, "Open atlas"));
    await settle();
    expect((field(document.body, "Role") as HTMLTextAreaElement).value).toBe("Reviews diffs");
    expect(hasButton(document.body, "Save")).toBe(true);
    await click(button(document.body, "All agents"));
    expect(hasButton(document.body, "Open atlas")).toBe(true);
  });

  it("saves with the revision it read, then shows the saved version under the new revision", async () => {
    const { bed } = await open([atlas], { "atlas-1a2b": full("atlas-1a2b", "atlas", 2) });
    bed.handlers["agents.update"] = () => full("atlas-1a2b", "atlas", 3, { role: "Saved role" });
    await click(button(document.body, "Open atlas"));
    await settle();
    await typeInto(field(document.body, "Role"), "Saved role");
    await click(button(document.body, "Save"));
    await settle();
    expect(bed.called("agents.update")[0]?.params).toMatchObject({ agentId: "atlas-1a2b", baseRevision: 2 });
    expect((field(document.body, "Role") as HTMLTextAreaElement).value).toBe("Saved role");
    await typeInto(field(document.body, "Role"), "Another");
    await click(button(document.body, "Save"));
    await settle();
    expect(bed.called("agents.update")[1]?.params).toMatchObject({ baseRevision: 3 });
  });

  it("re-keys the form when the agent changed elsewhere, dropping the unsaved draft", async () => {
    const views: Record<string, AgentView> = {
      "atlas-1a2b": full("atlas-1a2b", "atlas", 2, { role: "old" }),
    };
    await open([atlas], views);
    await click(button(document.body, "Open atlas"));
    await settle();
    await typeInto(field(document.body, "Role"), "my draft");
    views["atlas-1a2b"] = full("atlas-1a2b", "atlas", 3, { role: "edited elsewhere" });
    snapshot([{ ...atlas, lastActivityAt: 9 }]);
    await settle();
    expect((field(document.body, "Role") as HTMLTextAreaElement).value).toBe("edited elsewhere");
  });

  it("keeps the draft when the stream moves but the revision does not", async () => {
    await open([atlas], { "atlas-1a2b": full("atlas-1a2b", "atlas", 2, { role: "old" }) });
    await click(button(document.body, "Open atlas"));
    await settle();
    await typeInto(field(document.body, "Role"), "my draft");
    snapshot([{ ...atlas, lastActivityAt: 9 }]);
    await settle();
    expect((field(document.body, "Role") as HTMLTextAreaElement).value).toBe("my draft");
  });

  it("on a conflict reloads the agent and shows its saved version", async () => {
    const views: Record<string, AgentView> = {
      "atlas-1a2b": full("atlas-1a2b", "atlas", 2, { role: "old" }),
    };
    const { bed } = await open([atlas], views);
    bed.handlers["agents.update"] = () => {
      throw new RpcError("conflict");
    };
    await click(button(document.body, "Open atlas"));
    await settle();
    await typeInto(field(document.body, "Role"), "my draft");
    await click(button(document.body, "Save"));
    await settle();
    expect(alerts(document.body)).toHaveLength(1);
    views["atlas-1a2b"] = full("atlas-1a2b", "atlas", 4, { role: "someone else's" });
    await click(button(document.body, "Reload the agent"));
    await settle();
    expect((field(document.body, "Role") as HTMLTextAreaElement).value).toBe("someone else's");
    expect(alerts(document.body)).toEqual(["This agent changed elsewhere; your edits were not saved."]);
  });

  it("on a name clash, a reload with the same revision says the name is taken and not that the agent changed", async () => {
    const { bed } = await open([atlas], { "atlas-1a2b": full("atlas-1a2b", "atlas", 2) });
    bed.handlers["agents.update"] = () => {
      throw new RpcError("conflict");
    };
    await click(button(document.body, "Open atlas"));
    await settle();
    await click(button(document.body, "Save"));
    await settle();
    await click(button(document.body, "Reload the agent"));
    await settle();
    expect(alerts(document.body)).toEqual(["Another agent has this name. Pick another name."]);
    expect(body()).not.toContain("changed elsewhere");
  });

  it("drops the changed-elsewhere sentence once the agent is saved", async () => {
    const views: Record<string, AgentView> = { "atlas-1a2b": full("atlas-1a2b", "atlas", 2) };
    const { bed } = await open([atlas], views);
    bed.handlers["agents.update"] = () => {
      throw new RpcError("conflict");
    };
    await click(button(document.body, "Open atlas"));
    await settle();
    await click(button(document.body, "Save"));
    await settle();
    views["atlas-1a2b"] = full("atlas-1a2b", "atlas", 4);
    await click(button(document.body, "Reload the agent"));
    await settle();
    bed.handlers["agents.update"] = () => full("atlas-1a2b", "atlas", 5);
    await click(button(document.body, "Save"));
    await settle();
    expect(body()).not.toContain("changed elsewhere");
  });

  it("says when the agent is gone", async () => {
    await open([atlas], {});
    await click(button(document.body, "Open atlas"));
    await settle();
    expect(body()).toContain("This agent no longer exists.");
    expect(hasButton(document.body, "All agents")).toBe(true);
  });

  it("does not offer a form for a profile that cannot be read", async () => {
    const unreadable: AgentView = { ...full("atlas-1a2b", "atlas", 2), input: null, state: "unreadable" };
    await open([atlas], { "atlas-1a2b": unreadable });
    await click(button(document.body, "Open atlas"));
    await settle();
    expect(body()).toContain("This agent's saved profile cannot be read");
    expect(hasButton(document.body, "Save")).toBe(false);
  });

  it("moves focus to the new view's heading on a swap, and leaves it alone on the first render", async () => {
    await open([atlas], { "atlas-1a2b": full("atlas-1a2b", "atlas", 2) });
    expect(document.activeElement).toBe(document.body);
    await click(button(document.body, "Open atlas"));
    await settle();
    expect(document.activeElement?.tagName).toBe("H3");
    expect(document.activeElement?.textContent).toBe("atlas");
    await click(button(document.body, "All agents"));
    await settle();
    expect(document.activeElement?.tagName).toBe("H2");
    expect(document.activeElement?.id).toBe("agents-list-title");
  });

  it("speaks French", async () => {
    setLocale("fr");
    await open([{ ...atlas, state: "paused", paused: true }]);
    expect(hasButton(document.body, "Nouvel agent")).toBe(true);
    expect(body()).toContain("en pause");
  });
});

describe("Settings › Agents: the trash entry (J1b)", () => {
  const vm = { usable: true, reason: null, vmdVersion: "1", claudeToken: "set", agents: [] };
  const trashed = { agents: [{ agentId: "atlas-1a2b", name: "Atlas", deletedAt: 1 }] };

  it("shows a deleted agent's 'Purge now' in VM mode, after the delete note is gone", async () => {
    const bed = fakeRuntime();
    current.runtime = bed.runtime;
    bed.handlers["agents.vmStatus"] = () => vm;
    bed.handlers["agents.trash"] = () => trashed;
    snapshot([]);
    await mount(
      <TooltipProvider>
        <StepUpContext.Provider value={vi.fn() as unknown as StepUpRunner}>
          <AgentsSettings />
        </StepUpContext.Provider>
      </TooltipProvider>,
    );
    await settle();
    expect(hasButton(document.body, "Purge Atlas's trash now")).toBe(true);
  });

  it("reads no trash in host mode", async () => {
    const { bed } = await open([]);
    expect(bed.called("agents.trash")).toEqual([]);
  });
});
