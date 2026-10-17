import { describe, expect, it } from "vitest";
import { itemFromPath, pathOfItem } from "./item-path.ts";
import { itemKey } from "./model.ts";
import { parseWorkspace, serializeWorkspace } from "./persist.ts";

describe("the agent tab kind (M11R109)", () => {
  it("parses /agents/<id> for an id the daemon could have made", () => {
    expect(itemFromPath("/agents/atlas-1a2b", false)).toEqual({ kind: "agent", id: "atlas-1a2b" });
    expect(itemFromPath("/agents/atlas-1a2b/", false)).toEqual({ kind: "agent", id: "atlas-1a2b" });
    expect(itemFromPath("/agents/a-0000", false)).toEqual({ kind: "agent", id: "a-0000" });
  });

  it.each([
    "/agents",
    "/agents/",
    "/agents/Atlas",
    "/agents/Atlas-1a2b",
    "/agents/atlas",
    "/agents/atlas-1A2B",
    "/agents/atlas-1a2",
    "/agents/../x",
    "/agents/..",
    "/agents/%2e%2e",
    "/agents/atlas-1a2b/extra",
    "/agents/atlas%2F1a2b",
    "/agents/%E0%A4%A",
    "/agent/atlas-1a2b",
  ])("%s is not an agent path", (path) => {
    expect(itemFromPath(path, false)).toBeNull();
  });

  it("gives the tab key agent:<id> and the path /agents/<id>, and round-trips", () => {
    const item = { kind: "agent", id: "atlas-1a2b" } as const;
    expect(itemKey(item)).toBe("agent:atlas-1a2b");
    expect(pathOfItem(item)).toBe("/agents/atlas-1a2b");
    expect(itemFromPath(pathOfItem(item), false)).toEqual(item);
  });

  it("sends an id that is not an agent id to the start page, never to a bad URL", () => {
    expect(pathOfItem({ kind: "agent", id: "Atlas" })).toBe("/");
    expect(pathOfItem({ kind: "agent", id: "../x" })).toBe("/");
  });

  it("keeps an agent tab across a reload and drops one with an id the daemon could not have made", () => {
    const good = { key: "agent:atlas-1a2b", item: { kind: "agent", id: "atlas-1a2b" }, split: null };
    const bad = { key: "agent:Atlas", item: { kind: "agent", id: "Atlas" }, split: null };
    const raw = JSON.stringify({ v: 1, active: good.key, tabs: [good, bad] });
    const ws = parseWorkspace(raw, false);
    expect(ws.tabs.map((tab) => tab.key)).toEqual(["agent:atlas-1a2b"]);
    expect(parseWorkspace(serializeWorkspace(ws), false)).toEqual(ws);
  });
});
