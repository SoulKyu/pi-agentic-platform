// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore, type ItemRef } from "../../features/workspace/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { openPreview } from "./preview-tab.ts";
import { SPLIT_PANE_ID } from "./surface.ts";
import { useSurfaceView } from "./surface-view.ts";

const ITEM = { kind: "preview", box: "project:b1", name: "web" } as const satisfies ItemRef;
const ws = () => useWorkspaceStore.getState().ws;

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  usePreviewsStore.getState().reset();
  useSurfaceView.getState().show("none", "chat");
});

describe("openPreview", () => {
  it("splits the active session tab with the preview and arms the pane", () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
    openPreview(ITEM);
    expect(ws().tabs).toHaveLength(1);
    expect(ws().tabs[0]?.split?.item).toEqual(ITEM);
    expect(usePreviewsStore.getState().armed.has("project:b1/web")).toBe(true);
    expect(useSurfaceView.getState()).toMatchObject({ tabKey: "session:s1", view: "preview" });
  });

  it("opens a tab of its own when the active tab is not a session", () => {
    useWorkspaceStore.getState().open({ kind: "tasks" });
    openPreview(ITEM);
    expect(ws().tabs.map((tab) => tab.key)).toEqual(["tasks", "preview:project:b1/web"]);
    expect(ws().active).toBe("preview:project:b1/web");
    expect(usePreviewsStore.getState().armed.has("project:b1/web")).toBe(true);
  });

  it("focuses the split when the preview already is the split, and arms it again", () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
    openPreview(ITEM);
    usePreviewsStore.getState().disarm("project:b1/web");
    const pane = document.createElement("section");
    pane.id = SPLIT_PANE_ID;
    pane.tabIndex = -1;
    document.body.append(pane);
    openPreview(ITEM);
    expect(ws().tabs).toHaveLength(1);
    expect(document.activeElement).toBe(pane);
    expect(usePreviewsStore.getState().armed.has("project:b1/web")).toBe(true);
    pane.remove();
  });
});
