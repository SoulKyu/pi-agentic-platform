// @vitest-environment happy-dom
import { AgentInput, type AgentSummary } from "@pap/contracts";
import { TooltipProvider } from "@pap/ui";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../../i18n/index.ts";
import { RpcError, type RpcErrorCode, type Runtime } from "../../runtime/index.ts";
import { useAgentsStore } from "../../stores/agents-store.ts";
import { useLaunchStore } from "../../stores/launch-store.ts";
import { useSessionStore } from "../../stores/session-store.ts";
import { button, click, mount, settle, text } from "../../testing/dom.ts";
import { launchAt } from "../../testing/launch-bed.ts";
import { preloadMenu } from "../../testing/menu.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { setUnsavedFiles, resetUnsavedFiles } from "../../stores/unsaved-files.ts";
import { entry } from "../../features/files/files-bed.ts";
import { resetFolderMemory } from "../../features/files/folder-memory.ts";
import { AgentPaneEntry } from "./agent-pane-entry.tsx";
import { ShellContext } from "./shell-context.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

const shell = { username: "me", role: "owner" as const, passkeysAvailable: true, onSignedOut: vi.fn() };
const ID = "atlas-1a2b";
const ROOT = `/agents/${ID}`;
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
const launch = (stage: "image" | "disk") => ({
  kind: "launch",
  launch: launchAt(stage, Date.now() - 2000, { box: { kind: "agent", id: ID } }),
});

let bed: ReturnType<typeof fakeRuntime>;
let running: boolean;
let startError: RpcError | null;

beforeEach(async () => {
  localStorage.clear();
  resetFolderMemory();
  running = false;
  startError = null;
  bed = fakeRuntime("open");
  current.runtime = bed.runtime;
  bed.handlers["agents.openThread"] = () => ({ sessionId: "s1" });
  bed.handlers["agents.get"] = () => ({
    id: ID,
    name: "Atlas",
    input: AgentInput.parse({
      name: "Atlas",
      role: "r",
      model: { provider: "anthropic", modelId: "sonnet" },
    }),
    state: "active",
    threadSessionId: "s1",
    unread: 0,
    paused: false,
    quarantinedAt: null,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  bed.handlers["agents.events"] = () => ({ events: [], more: false, next: null });
  bed.handlers["agents.markRead"] = () => ({});
  bed.handlers["agents.prompts"] = () => ({ names: [] });
  bed.handlers["agents.vmStatus"] = () => ({
    usable: true,
    reason: null,
    vmdVersion: "1",
    claudeToken: "set",
    agents: [],
  });
  bed.handlers["agents.files.list"] = () => ({ files: [] });
  bed.handlers["files.list"] = () => {
    if (!running) throw new RpcError("box_stopped");
    return { entries: [entry("notes.md")], truncated: false };
  };
  bed.handlers["agents.startBox"] = () => {
    if (startError !== null) throw startError;
    return { ok: true };
  };
  useAgentsStore.getState().reset();
  useLaunchStore.getState().reset();
  useSessionStore.setState({ views: {} });
  await preloadMenu();
});
afterEach(() => {
  setLocale("en");
  resetUnsavedFiles();
  vi.unstubAllGlobals();
});

const showFiles = async (tab = "Files") => {
  act(() => {
    useAgentsStore.getState().apply({ kind: "snapshot", agents: [atlas], requests: [], truncated: false });
  });
  const page = await mount(
    <TooltipProvider>
      <ShellContext.Provider value={shell}>
        <AgentPaneEntry
          agentId={ID}
          avatarStyle="outlined"
          eventCards="cards"
          statusPanel="hidden"
          thread={(slot) => <div data-thread="">{slot.header}</div>}
          onOpenSettings={() => {}}
          onOpenSession={() => {}}
          onOpenTrigger={() => {}}
        />
      </ShellContext.Provider>
    </TooltipProvider>,
  );
  await settle();
  await click(button(page.container, tab));
  await settle();
  return page.container;
};

describe("the agent's Files tab: the VM's files", () => {
  it("lists the folder of the agent, then the imported credentials under their own heading", async () => {
    running = true;
    const c = await showFiles();
    expect(bed.called("files.list").map((call) => (call.params as { path: string }).path)).toContain(ROOT);
    expect(c.querySelector('[role="treeitem"][data-path="/agents/atlas-1a2b/notes.md"]')).not.toBeNull();
    const tab = c.querySelector("[data-agent-files-tab]") as HTMLElement;
    const [explorer, credentials] = Array.from(tab.children);
    expect(explorer?.querySelector('[role="tree"]')).not.toBeNull();
    expect(credentials?.querySelector("[data-agent-files] h3")?.textContent).toBe("Imported credentials");
    expect(tab.className).toContain("flex-col");
  });

  it("a stopped VM shows the panel, and START calls agents.startBox with a command id", async () => {
    const c = await showFiles();
    expect(text(c)).toContain("VM stopped");
    expect(text(c)).toContain("The agent's VM is stopped. Start it to see its files.");
    expect(c.querySelector('[role="tree"]')).toBeNull();
    await click(button(c, "Start"));
    expect(bed.called("agents.startBox")).toEqual([
      expect.objectContaining({
        params: { agentId: ID },
        options: { commandId: expect.stringMatching(/^bed-cmd-\d{8}$/) },
      }),
    ]);
    expect(bed.called("projects.startBox")).toEqual([]);
  });

  it("says the panel in French", async () => {
    setLocale("fr");
    const c = await showFiles("Fichiers");
    expect(text(c)).toContain("VM arrêtée");
    expect(text(c)).toContain("La VM de l'agent est arrêtée. Démarrez-la pour voir ses fichiers.");
    expect(button(c, "Démarrer")).not.toBeNull();
    expect(text(c)).toContain("Identifiants importés");
  });

  it.each<[RpcErrorCode, string]>([
    ["not_found", "This agent no longer exists or its profile cannot be read, so there is no VM to start."],
    ["capacity", "The agent's VM could not start: the server is at capacity."],
    [
      "agent_paused",
      "Resume it (Settings tab for a quarantined agent, header for a paused one), then start the VM.",
    ],
    ["vm_bundle_stale", "Run sudo pap vm setup on the server, then start the VM again."],
    ["sandbox_unavailable", "The agent's VM could not start: this machine has no microVM support set up."],
    ["disk_low", "The agent's VM was not started: the disk is almost full."],
    ["command_failed", "The agent's VM could not start. Its files are intact."],
    ["internal", "The agent's VM could not start. Its files are intact."],
  ])("a refused start (%s) says why in the agent's words", async (code, words) => {
    startError = new RpcError(code);
    const c = await showFiles();
    await click(button(c, "Start"));
    await settle();
    expect(text(c)).toContain(words);
    expect(text(c)).not.toContain("pick another project");
    expect(text(c)).not.toContain("The box");
  });

  it("says a refused start in French, agent wording", async () => {
    startError = new RpcError("not_found");
    setLocale("fr");
    const c = await showFiles("Fichiers");
    await click(button(c, "Démarrer"));
    await settle();
    expect(text(c)).toContain(
      "Cet agent n'existe plus ou son profil est illisible, il n'y a donc pas de VM à démarrer.",
    );
  });

  it("a launch that ends without success lists once more and shows the panel again, no loop", async () => {
    const c = await showFiles();
    await act(async () => {
      useLaunchStore.getState().apply(launch("image"));
    });
    const before = bed.called("files.list").length;
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "end", id: "l1", done: true, ok: false });
    });
    await settle();
    await settle();
    expect(bed.called("files.list").length).toBe(before + 1);
    expect(text(c)).toContain("VM stopped");
    expect(button(c, "Start").disabled).toBe(false);
  });

  it("while a launch of the agent runs START is disabled and names the stage; its end lists again", async () => {
    const c = await showFiles();
    const start = button(c, "Start");
    await act(async () => {
      useLaunchStore.getState().apply(launch("image"));
    });
    await vi.waitFor(() => expect(start.textContent).toBe("Building the image…"));
    expect(start.disabled).toBe(true);
    const before = bed.called("files.list").length;
    running = true;
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "end", id: "l1", done: true, ok: true });
    });
    await settle();
    expect(bed.called("files.list").length).toBeGreaterThan(before);
    expect(c.querySelector('[role="treeitem"][data-path="/agents/atlas-1a2b/notes.md"]')).not.toBeNull();
    expect(text(c)).not.toContain("VM stopped");
  });

  it("a launch of another agent changes nothing here", async () => {
    const c = await showFiles();
    const before = bed.called("files.list").length;
    await act(async () => {
      useLaunchStore.getState().apply({
        kind: "launch",
        launch: launchAt("image", Date.now() - 2000, { box: { kind: "agent", id: "other-9f8e" } }),
      });
    });
    await act(async () => {
      useLaunchStore.getState().apply({ kind: "end", id: "l1", done: true, ok: true });
    });
    await settle();
    expect(button(c, "Start").disabled).toBe(false);
    expect(bed.called("files.list").length).toBe(before);
  });

  it("a START that resolves ok with no launch lists the root once more", async () => {
    const c = await showFiles();
    const before = bed.called("files.list").length;
    running = true;
    await click(button(c, "Start"));
    await settle();
    expect(bed.called("files.list").length).toBe(before + 1);
    expect(c.querySelector('[role="treeitem"][data-path="/agents/atlas-1a2b/notes.md"]')).not.toBeNull();
  });

  it.each(["Thread", "Settings"])("leaving Files for %s with unsaved edits asks first", async (target) => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    running = true;
    const c = await showFiles();
    setUnsavedFiles(ROOT, true);
    await click(button(c, target));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(c.querySelector("[data-agent-files-tab]")).not.toBeNull();
    // Settings needs the shell's step-up runner to render: the guard is the same one, proven by the refusal above.
    if (target === "Settings") return;
    confirm.mockReturnValue(true);
    await click(button(c, target));
    expect(c.querySelector("[data-agent-files-tab]")).toBeNull();
  });

  it("leaving Files with no unsaved edit does not ask", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    running = true;
    const c = await showFiles();
    await click(button(c, "Thread"));
    expect(confirm).not.toHaveBeenCalled();
    expect(c.querySelector("[data-agent-files-tab]")).toBeNull();
  });
});
