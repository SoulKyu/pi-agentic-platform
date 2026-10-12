import { describe, expect, it } from "vitest";
import {
  activeTab,
  closeTab,
  cycleTab,
  EMPTY_WORKSPACE,
  itemKey,
  MAX_TABS,
  openItem,
  setSplitRatio,
  splitTab,
  unsplitTab,
  type Workspace,
} from "./model.ts";

const session = (id: string) => ({ kind: "session", id }) as const;
const keys = (ws: Workspace) => ws.tabs.map((t) => t.key);

describe("workspace model", () => {
  it("opens an item once and activates it again later", () => {
    let ws = openItem(EMPTY_WORKSPACE, session("a"));
    ws = openItem(ws, { kind: "home" });
    ws = openItem(ws, session("a"));
    expect([keys(ws), ws.active]).toEqual([["session:a", "home"], "session:a"]);
  });

  it("keeps one settings tab and moves it to the requested section", () => {
    let ws = openItem(EMPTY_WORKSPACE, { kind: "settings", section: "appearance" });
    ws = openItem(ws, { kind: "settings", section: "shortcuts" });
    expect(ws.tabs).toEqual([
      { key: "settings", item: { kind: "settings", section: "shortcuts" }, split: null },
    ]);
  });

  it("closes the oldest inactive tab when a 25th item opens", () => {
    let ws = EMPTY_WORKSPACE;
    for (let i = 0; i < MAX_TABS; i++) ws = openItem(ws, session(String(i)));
    ws = openItem(ws, session("new"));
    expect(ws.tabs).toHaveLength(MAX_TABS);
    expect(keys(ws)[0]).toBe("session:1");
    expect(ws.active).toBe("session:new");
  });

  it("never evicts the active tab, even when it is the oldest", () => {
    let ws = EMPTY_WORKSPACE;
    for (let i = 0; i < MAX_TABS; i++) ws = openItem(ws, session(String(i)));
    ws = { ...ws, active: "session:0" };
    ws = openItem(ws, session("new"));
    expect(ws.tabs).toHaveLength(MAX_TABS);
    expect(keys(ws)[0]).toBe("session:0");
    expect(keys(ws)).not.toContain("session:1");
    expect(ws.active).toBe("session:new");
  });

  it("keeps keys unique over many opens", () => {
    let ws = EMPTY_WORKSPACE;
    for (let i = 0; i < 100; i++) ws = openItem(ws, session(String(i % 30)));
    expect(new Set(keys(ws)).size).toBe(ws.tabs.length);
    expect(ws.tabs.length).toBeLessThanOrEqual(MAX_TABS);
  });

  it("activates the right neighbour, then the left one, when the active tab closes", () => {
    let ws = [session("a"), session("b"), session("c")].reduce(openItem, EMPTY_WORKSPACE);
    ws = closeTab(openItem(ws, session("b")), "session:b");
    expect(ws.active).toBe("session:c");
    ws = closeTab(ws, "session:c");
    expect(ws.active).toBe("session:a");
    expect(closeTab(ws, "session:a")).toEqual(EMPTY_WORKSPACE);
  });

  it("closing an inactive or unknown tab keeps the active one", () => {
    const ws = [session("a"), session("b")].reduce(openItem, EMPTY_WORKSPACE);
    expect(closeTab(ws, "session:a").active).toBe("session:b");
    expect(closeTab(ws, "session:zzz")).toBe(ws);
  });

  it("cycles with wrap-around", () => {
    const ws = [session("a"), session("b")].reduce(openItem, EMPTY_WORKSPACE);
    expect(cycleTab(ws, 1).active).toBe("session:a");
    expect(cycleTab(ws, -1).active).toBe("session:a");
    expect(cycleTab(EMPTY_WORKSPACE, 1)).toBe(EMPTY_WORKSPACE);
  });

  it("splits with another item, clamps the ratio, and returns the same object for an unchanged ratio", () => {
    const ws = openItem(EMPTY_WORKSPACE, session("a"));
    expect(splitTab(ws, "session:a", session("a"))).toBe(ws);
    const split = splitTab(ws, "session:a", { kind: "home" });
    expect(activeTab(split)?.split).toEqual({ item: { kind: "home" }, ratio: 0.5 });
    expect(activeTab(setSplitRatio(split, "session:a", 0.99))?.split?.ratio).toBe(0.85);
    expect(activeTab(setSplitRatio(split, "session:a", 0.01))?.split?.ratio).toBe(0.15);
    expect(activeTab(setSplitRatio(split, "session:a", Number.NaN))?.split?.ratio).toBe(0.5);
    expect(setSplitRatio(split, "session:a", 0.5)).toBe(split);
    expect(activeTab(unsplitTab(split, "session:a"))?.split).toBeNull();
  });

  it("keys items stably", () => {
    expect([
      itemKey({ kind: "home" }),
      itemKey(session("x")),
      itemKey({ kind: "settings", section: "language" }),
      itemKey({ kind: "dev-ui" }),
    ]).toEqual(["home", "session:x", "settings", "dev-ui"]);
  });
});
