import { describe, expect, it, vi } from "vitest";
import { COMMANDS, keyNames } from "../../features/commands/index.ts";
import { DEFAULT_KEYBINDINGS, KNOWN_COMMANDS } from "../../features/commands/defaults.ts";
import { mergeWithDefaults } from "../../features/commands/resolve.ts";
import { rankItems } from "../../features/commands/palette/rank.ts";
import { t } from "../../i18n/index.ts";
import { reduceLanes, EMPTY_LANES } from "../../stores/lane-reducer.ts";
import { laneSnapshot, laneView } from "../../testing/lane-fixtures.ts";
import { buildPaletteItems } from "./palette-items.ts";

const { rules } = mergeWithDefaults(DEFAULT_KEYBINDINGS, [], KNOWN_COMMANDS);
const lanes = reduceLanes(
  EMPTY_LANES,
  laneSnapshot([
    laneView({ id: "fix-a-1a2b", title: "Fix the thing", branch: "pi/fix-a" }),
    laneView({ id: "old-1a2b", branch: "pi/old", state: "archiving" }),
  ]),
);
const build = (has: (id: string) => boolean = () => false) => {
  const navigate = vi.fn();
  const items = buildPaletteItems({
    commands: COMMANDS,
    has,
    rules,
    platform: "other",
    names: keyNames(t),
    tabs: [],
    sessions: [{ id: "s", cwd: "/w/x", name: "Fix login", status: "idle", createdAt: 1, updatedAt: 1 }],
    views: {},
    lanes,
    laneFacts: [{ cwd: "/p/worktrees/fix-a-1a2b", status: "running", needsInput: false }],
    t,
    navigate,
    run: vi.fn(),
  });
  return { items, navigate };
};

describe("the Lanes group", () => {
  it("lists the live lanes with branch and status word, archived ones excluded", () => {
    const { items } = build();
    const rows = items.filter((i) => i.group === "lanes");
    expect(rows.map((i) => [i.title, i.detail])).toEqual([["Fix the thing", "pi/fix-a · Working"]]);
  });

  it("opens the lane tab", () => {
    const { items, navigate } = build();
    items.find((i) => i.id === "lane:fix-a-1a2b")?.run();
    expect(navigate).toHaveBeenCalledWith({ kind: "lane", id: "fix-a-1a2b" });
  });

  it("comes before Sessions and filters by title and branch", () => {
    const { items } = build();
    expect(rankItems(items, "fix").groups.map((g) => g.group)).toEqual(["lanes", "sessions"]);
    expect(rankItems(items, "pi/fix-a").groups.map((g) => g.group)).toEqual(["lanes"]);
    expect(rankItems(items, "thing").groups.map((g) => g.group)).toEqual(["lanes"]);
  });

  it("offers New lane with its chord only when a handler is registered", () => {
    expect(build().items.some((i) => i.id === "action:lanes.new")).toBe(false);
    const action = build((id) => id === "lanes.new").items.find((i) => i.id === "action:lanes.new");
    expect(action?.title).toBe("New lane");
    expect(action?.chord).toEqual(expect.arrayContaining(["L"]));
  });
});
