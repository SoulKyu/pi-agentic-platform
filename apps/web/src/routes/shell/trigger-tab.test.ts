import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { openTriggerInstead } from "./trigger-tab.ts";

beforeEach(() => useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE }));

describe("openTriggerInstead", () => {
  it("replaces the new: tab with the saved trigger's tab, which is the active one", () => {
    const store = useWorkspaceStore.getState();
    store.open({ kind: "trigger", id: "new:p1" });
    openTriggerInstead("new:p1", "g9");
    const { ws } = useWorkspaceStore.getState();
    const keys = ws.tabs.map((tab) => tab.key);
    expect(keys).toContain("trigger:g9");
    expect(keys).not.toContain("trigger:new:p1");
    expect(ws.active).toBe("trigger:g9");
  });
});
