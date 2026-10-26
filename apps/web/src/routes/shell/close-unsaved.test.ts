// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../i18n/register-files.ts";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { resetUnsavedFiles, setUnsavedFiles } from "../../stores/unsaved-files.ts";
import { closeItem, toggleSplit, unsplitTab } from "./tab-actions.ts";

const ws = () => useWorkspaceStore.getState().ws;
const navigate = vi.fn(async () => undefined);
const files = { kind: "files", root: "/w/api" } as const;
let confirm: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetUnsavedFiles();
  useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  confirm = vi.fn(() => false);
  vi.stubGlobal("confirm", confirm);
});
afterEach(() => vi.unstubAllGlobals());

const openTabs = () => {
  const store = useWorkspaceStore.getState();
  store.open({ kind: "home" });
  store.open(files);
  return ws().tabs.find((tab) => tab.item.kind === "files")?.key as string;
};

describe("closing a files pane with unsaved edits", () => {
  it("closes a clean files tab without asking", () => {
    const key = openTabs();
    closeItem(navigate as never, key);
    expect(confirm).not.toHaveBeenCalled();
    expect(ws().tabs.some((tab) => tab.key === key)).toBe(false);
  });

  it("asks before closing the tab, and keeps it on No", () => {
    const key = openTabs();
    setUnsavedFiles("/w/api", true);
    closeItem(navigate as never, key);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ws().tabs.some((tab) => tab.key === key)).toBe(true);
    confirm.mockReturnValue(true);
    closeItem(navigate as never, key);
    expect(ws().tabs.some((tab) => tab.key === key)).toBe(false);
  });

  it("asks before closing the split that holds the pane", () => {
    openTabs();
    const store = useWorkspaceStore.getState();
    const home = ws().tabs[0]?.key as string;
    store.split(home, files);
    setUnsavedFiles("/w/api", true);
    unsplitTab(home);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ws().tabs[0]?.split).not.toBeNull();
    confirm.mockReturnValue(true);
    unsplitTab(home);
    expect(ws().tabs[0]?.split).toBeNull();
  });

  it("asks on the split toggle as well", () => {
    openTabs();
    const home = ws().tabs[0]?.key as string;
    useWorkspaceStore.getState().split(home, files);
    useWorkspaceStore.getState().open({ kind: "home" });
    setUnsavedFiles("/w/api", true);
    useWorkspaceStore.setState({ ws: { ...ws(), active: home } });
    toggleSplit();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ws().tabs[0]?.split).not.toBeNull();
  });

  it("asks before closing an agent tab whose explorer holds unsaved edits", () => {
    const store = useWorkspaceStore.getState();
    store.open({ kind: "home" });
    store.open({ kind: "agent", id: "atlas-1a2b" });
    const key = ws().tabs.find((tab) => tab.item.kind === "agent")?.key as string;
    closeItem(navigate as never, key);
    expect(confirm).not.toHaveBeenCalled();
    store.open({ kind: "agent", id: "atlas-1a2b" });
    setUnsavedFiles("/agents/atlas-1a2b", true);
    closeItem(navigate as never, key);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(ws().tabs.some((tab) => tab.key === key)).toBe(true);
    confirm.mockReturnValue(true);
    closeItem(navigate as never, key);
    expect(ws().tabs.some((tab) => tab.key === key)).toBe(false);
  });
});
