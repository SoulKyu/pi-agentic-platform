// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_WORKSPACE } from "./model.ts";
import { WORKSPACE_KEY } from "./persist.ts";
import { useWorkspaceStore } from "./workspace-store.ts";

const report = vi.hoisted(() => ({ reportClientIssue: vi.fn() }));
vi.mock("../../lib/report.ts", () => report);

describe("workspace store", () => {
  beforeEach(() => {
    localStorage.clear();
    report.reportClientIssue.mockClear();
    useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE });
  });
  afterEach(() => vi.restoreAllMocks());

  it("persists an opened session", () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "a" });
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "null")).toEqual({
      v: 1,
      active: "session:a",
      tabs: [{ key: "session:a", item: { kind: "session", id: "a" }, split: null }],
    });
  });

  it("keeps the in-memory workspace and reports a refused write", () => {
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    useWorkspaceStore.getState().open({ kind: "session", id: "a" });
    expect(useWorkspaceStore.getState().ws.active).toBe("session:a");
    expect(report.reportClientIssue.mock.calls).toEqual([["storage_refused"]]);
  });

  it("writes nothing when the ratio does not change", () => {
    const store = useWorkspaceStore.getState();
    store.open({ kind: "session", id: "a" });
    store.split("session:a", { kind: "home" });
    const spy = vi.spyOn(localStorage, "setItem");
    store.setRatio("session:a", 0.5);
    expect(spy).not.toHaveBeenCalled();
    store.setRatio("session:a", 0.7);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("close, cycle and unsplit go through the model and persist", () => {
    const store = useWorkspaceStore.getState();
    store.open({ kind: "session", id: "a" });
    store.open({ kind: "home" });
    store.cycle(1);
    expect(useWorkspaceStore.getState().ws.active).toBe("session:a");
    store.split("session:a", { kind: "home" });
    store.unsplit("session:a");
    store.close("session:a");
    expect(JSON.parse(localStorage.getItem(WORKSPACE_KEY) ?? "null").tabs).toEqual([
      { key: "home", item: { kind: "home" }, split: null },
    ]);
  });
});
