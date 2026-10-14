import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE, itemKey, useWorkspaceStore } from "../../features/workspace/index.ts";
import { leaveTerminal, openTerminalInstead } from "./terminal-tab.ts";

const term = (id: string) => ({ kind: "terminal", id }) as const;
const keys = () => useWorkspaceStore.getState().ws.tabs.map((tab) => tab.key);
const splitOf = (key: string) => useWorkspaceStore.getState().ws.tabs.find((tab) => tab.key === key)?.split;

beforeEach(() => useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE }));

describe("leaving a terminal pane (MC35)", () => {
  it("closes the tab that shows the terminal", () => {
    useWorkspaceStore.getState().open(term("a"));
    useWorkspaceStore.getState().open({ kind: "home" });
    leaveTerminal(term("a"));
    expect(keys()).toEqual(["home"]);
  });

  it("unsplits a terminal shown as the split of a tab: the tab stays", () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
    useWorkspaceStore.getState().split("session:s1", term("a"));
    expect(splitOf("session:s1")?.item).toEqual(term("a"));
    leaveTerminal(term("a"));
    expect(keys()).toEqual(["session:s1"]);
    expect(splitOf("session:s1")).toBeNull();
  });

  it("a new terminal replaces the old one in its split, or in its tab", () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
    useWorkspaceStore.getState().split("session:s1", term("a"));
    openTerminalInstead(term("a"), "b");
    expect(splitOf("session:s1")).toBeNull();
    expect(keys()).toContain(itemKey(term("b")));
    openTerminalInstead(term("b"), "c");
    expect(keys()).toEqual(["session:s1", "terminal:c"]);
  });
});
