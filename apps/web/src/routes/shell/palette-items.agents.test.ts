import type { AgentSummary } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { COMMANDS, keyNames } from "../../features/commands/index.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../../features/commands/defaults.ts";
import { mergeWithDefaults } from "../../features/commands/resolve.ts";
import { rankItems } from "../../features/commands/palette/rank.ts";
import { t } from "../../i18n/index.ts";
import { buildPaletteItems } from "./palette-items.ts";

const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
const agent = (id: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id.split("-")[0]?.replace(/^./, (c) => c.toUpperCase()) ?? id,
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
  ...patch,
});
const build = (agents: readonly AgentSummary[], has: (id: string) => boolean = () => true) => {
  const navigate = vi.fn();
  const run = vi.fn();
  const items = buildPaletteItems({
    commands: COMMANDS,
    has,
    rules,
    platform: "other",
    names: keyNames(t),
    tabs: [{ key: "agent:atlas-1a2b", item: { kind: "agent", id: "atlas-1a2b" }, split: null }],
    sessions: [],
    views: {},
    agents,
    t,
    navigate,
    run,
  });
  return { items, navigate, run };
};
const ATLAS = agent("atlas-1a2b", { state: "needs_input", unread: 2 });

describe("the Agents group of the palette (M11R109)", () => {
  it("lists each agent with its state word, in creation order, and opens its tab", () => {
    const { items, navigate } = build([ATLAS, agent("bolt-0001", { unread: 0 })]);
    const rows = items.filter((i) => i.group === "agents" && i.id.startsWith("agent:"));
    expect(rows.map((i) => [i.title, i.detail])).toEqual([
      ["Open agent Atlas", "needs input · 2 unread"],
      ["Open agent Bolt", "idle"],
    ]);
    rows[0]?.run();
    expect(navigate).toHaveBeenCalledWith({ kind: "agent", id: "atlas-1a2b" });
  });

  it("opens Settings › Agents for an agent whose profile is unreadable", () => {
    const { items, navigate } = build([agent("atlas-1a2b", { state: "paused", unreadable: true })]);
    items.find((i) => i.id === "agent:atlas-1a2b")?.run();
    expect(navigate).toHaveBeenCalledWith({ kind: "settings", section: "agents" });
  });

  it("says an unreadable profile opens Settings, in the row title and its detail", () => {
    const { items } = build([agent("atlas-1a2b", { state: "paused", unreadable: true })]);
    const row = items.find((i) => i.id === "agent:atlas-1a2b");
    expect(row?.title).toBe("Fix agent Atlas");
    expect(row?.detail).toBe("paused · profile unreadable");
    expect(row?.searchTerms).toContain("Atlas");
  });

  it("offers New agent when the shell can open the dialog, and runs that command", () => {
    const { items, run } = build([]);
    const row = items.find((i) => i.id === "agents:new");
    expect([row?.group, row?.title]).toEqual(["agents", "New agent"]);
    row?.run();
    expect(run).toHaveBeenCalledWith("agents.new");
    expect(build([], () => false).items.some((i) => i.id === "agents:new")).toBe(false);
  });

  it("titles an open agent tab with the agent's name, not a generic word", () => {
    const { items } = build([ATLAS]);
    expect(items.find((i) => i.id === "open:agent:atlas-1a2b")?.title).toBe("Atlas");
  });

  it("filters by name and sits between Open and Lanes", () => {
    const { items } = build([ATLAS]);
    expect(rankItems(items, "atlas").groups.map((g) => g.group)).toEqual(["open", "agents"]);
    expect(rankItems(items, "new agent").groups.map((g) => g.group)).toContain("agents");
  });
});
