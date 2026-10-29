// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, mount } from "../../testing/dom.ts";
import { AGENT_BOX, previewView, PROJECT_BOX as BOX, PROJECT_ID } from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellProject, shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { renderItem } from "./pane-renderers.tsx";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));
// The session screen is a stub that draws what the shell hands it above the composer.
vi.mock("../../features/sessions/SessionScreen.tsx", async () => {
  const { createElement: h } = await import("react");
  return {
    SessionScreen: (props: { sessionId: string; beforeComposer?: React.ReactNode }) =>
      h("div", { "data-stub": "session" }, props.sessionId, props.beforeComposer),
  };
});
// The agent tab hands its thread slot to `thread`: the stub plays the agent screen.
vi.mock("./agent-pane-entry.tsx", () => {
  return {
    AgentPaneEntry: (props: { agentId: string; thread(slot: unknown): React.ReactNode }) =>
      props.thread({ sessionId: "agent-thread", header: null, beforeComposer: null, interleave: {} }),
  };
});

beforeEach(() => {
  current.runtime = fakeRuntime("open").runtime;
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  usePreviewsStore.getState().reset();
  useShellStore.getState().reset();
  useShellStore.getState().apply(
    shellSnapshot(
      [
        shellSession({ id: "boxed", projectId: PROJECT_ID, cwd: `/boxes/${PROJECT_ID}/project` }),
        shellSession({ id: "hosted", projectId: "h1", cwd: "/w/h1" }),
      ],
      {
        projects: [
          boxProject("running", { id: PROJECT_ID, root: `/boxes/${PROJECT_ID}/project` }),
          shellProject({ id: "h1", kind: "host" }),
        ],
      },
    ),
  );
});

const lines = (container: HTMLElement) => container.querySelectorAll("[data-preview-line]").length;

describe("the strip above the composer", () => {
  it("shows a box session's running service and opens it as the tab's split", async () => {
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: BOX })] });
    useWorkspaceStore.getState().open({ kind: "session", id: "boxed" });
    const page = await mount(<>{renderItem({ kind: "session", id: "boxed" })}</>);
    await vi.waitFor(() => expect(lines(page.container)).toBe(1), { timeout: 2_000 });
    button(page.container, "Open preview").click();
    expect(useWorkspaceStore.getState().ws.tabs[0]?.split?.item).toEqual({
      kind: "preview",
      box: `project:${PROJECT_ID}`,
      name: "web",
    });
  });

  it("shows nothing for a host session", async () => {
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: BOX })] });
    const page = await mount(<>{renderItem({ kind: "session", id: "hosted" })}</>);
    await vi.waitFor(() => expect(page.container.querySelector('[data-stub="session"]')).not.toBeNull());
    expect(lines(page.container)).toBe(0);
  });

  it("an agent's thread takes its strip from the agent's own box", async () => {
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: AGENT_BOX })] });
    const page = await mount(<>{renderItem({ kind: "agent", id: "atlas-1a2b" })}</>);
    await vi.waitFor(() => expect(lines(page.container)).toBe(1), { timeout: 2_000 });
  });
});

describe("the preview renderer", () => {
  it("renders the pane not open, and loads nothing, for a restored item", async () => {
    const bed = fakeRuntime("open");
    current.runtime = bed.runtime;
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: BOX })] });
    const page = await mount(
      <>{renderItem({ kind: "preview", box: `project:${PROJECT_ID}`, name: "web" })}</>,
    );
    await vi.waitFor(
      () => expect(page.container.textContent).toContain("Open the preview to load the page."),
      {
        timeout: 2_000,
      },
    );
    expect(bed.called("previews.open")).toHaveLength(0);
    expect(page.container.querySelector("iframe")).toBeNull();
  });

  it("is a not-found state for a box key it cannot read", async () => {
    const page = await mount(<>{renderItem({ kind: "preview", box: "nonsense", name: "web" })}</>);
    expect(page.container.querySelector("iframe")).toBeNull();
    expect(page.container.textContent).not.toContain("Open the preview");
  });
});
