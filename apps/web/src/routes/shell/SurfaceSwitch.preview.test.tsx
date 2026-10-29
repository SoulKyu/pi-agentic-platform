// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { useShellStore } from "../../stores/shell-store.ts";
import { boxProject } from "../../testing/box-fixtures.ts";
import { button, click, mount, settle } from "../../testing/dom.ts";
import { previewView, PROJECT_BOX as BOX, PROJECT_ID } from "../../testing/previews-fixtures.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { shellSession, shellSnapshot } from "../../testing/shell-snapshot.ts";
import { SurfaceSwitch } from "./SurfaceSwitch.tsx";
import { useSurfaceView } from "./surface-view.ts";

const current = vi.hoisted(() => ({ runtime: undefined as Runtime | undefined }));
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () => current.runtime,
}));

beforeEach(() => {
  current.runtime = fakeRuntime("open").runtime;
  localStorage.clear();
  useShellStore.getState().reset();
  useShellStore
    .getState()
    .apply(
      shellSnapshot(
        [shellSession({ id: "s1", projectId: PROJECT_ID, cwd: `/boxes/${PROJECT_ID}/project` })],
        { projects: [boxProject("running", { id: PROJECT_ID, root: `/boxes/${PROJECT_ID}/project` })] },
      ),
    );
  usePreviewsStore.getState().reset();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
  useSurfaceView.getState().show("session:s1", "chat");
});

const labels = (container: HTMLElement) =>
  [...container.querySelectorAll("button")].map((one) => one.textContent);

describe("the phone's Preview entry", () => {
  it("appears only while a service of the session's box runs", async () => {
    const page = await mount(<SurfaceSwitch tabKey="session:s1" sessionId="s1" selected="chat" />);
    await settle();
    expect(labels(page.container)).not.toContain("Preview");
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: BOX })] });
    await settle();
    expect(labels(page.container)).toContain("Preview");
    usePreviewsStore.getState().apply({
      type: "snapshot",
      services: [previewView({ box: { kind: "project", id: "0b8f6f6e-9999-4222-8333-444455556666" } })],
    });
    await settle();
    expect(labels(page.container)).not.toContain("Preview");
  });

  it("splits the tab with the service, arms the pane and shows the preview view", async () => {
    usePreviewsStore.getState().apply({ type: "snapshot", services: [previewView({ box: BOX })] });
    const page = await mount(<SurfaceSwitch tabKey="session:s1" sessionId="s1" selected="chat" />);
    await settle();
    await click(button(page.container, "Preview"));
    const tab = useWorkspaceStore.getState().ws.tabs[0];
    expect(tab?.split?.item).toEqual({ kind: "preview", box: `project:${PROJECT_ID}`, name: "web" });
    expect(useSurfaceView.getState()).toMatchObject({ tabKey: "session:s1", view: "preview" });
    expect(usePreviewsStore.getState().armed.has(`project:${PROJECT_ID}/web`)).toBe(true);
  });

  it("stays as the selected entry while the preview is shown, even after the service stopped", async () => {
    const page = await mount(<SurfaceSwitch tabKey="session:s1" sessionId="s1" selected="preview" />);
    await settle();
    const entry = button(page.container, "Preview");
    expect(entry.getAttribute("aria-current")).toBe("true");
  });
});
