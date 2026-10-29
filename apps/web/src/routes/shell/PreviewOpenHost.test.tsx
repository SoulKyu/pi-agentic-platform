// @vitest-environment happy-dom
import { act } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { usePreviewsStore } from "../../stores/previews-store.ts";
import { mount } from "../../testing/dom.ts";
import { PreviewOpenHost } from "./PreviewOpenHost.tsx";

beforeEach(() => {
  localStorage.clear();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  usePreviewsStore.getState().reset();
});

describe("PreviewOpenHost", () => {
  it("opens the requested preview armed, once, and clears the request", async () => {
    await mount(<PreviewOpenHost />);
    await act(async () => usePreviewsStore.getState().request({ box: "project:b1", name: "web" }));
    const keys = useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key);
    expect(keys).toEqual(["preview:project:b1/web"]);
    expect(usePreviewsStore.getState().armed.has("project:b1/web")).toBe(true);
    expect(usePreviewsStore.getState().requested).toBeNull();
  });
});
