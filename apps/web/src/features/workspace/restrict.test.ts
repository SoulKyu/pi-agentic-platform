import { describe, expect, it } from "vitest";
import { itemFromPath } from "./item-path.ts";
import { restrictWorkspace, type Workspace } from "./model.ts";

const ws: Workspace = {
  tabs: [
    { key: "settings", item: { kind: "settings", section: "models" }, split: null },
    {
      key: "home",
      item: { kind: "home" },
      split: { item: { kind: "settings", section: "users" }, ratio: 0.5 },
    },
  ],
  active: "settings",
};

describe("a member's workspace", () => {
  it("restores a workspace that had /settings/models open as Appearance, split included", () => {
    const restored = restrictWorkspace(ws, "member");
    expect(restored.tabs.map((tab) => tab.item)).toEqual([
      { kind: "settings", section: "appearance" },
      { kind: "home" },
    ]);
    expect(restored.tabs[1]?.split?.item).toEqual({ kind: "settings", section: "appearance" });
    expect(restored.active).toBe("settings");
  });

  it("leaves an owner's workspace as it is", () => {
    expect(restrictWorkspace(ws, "owner")).toBe(ws);
  });

  it("opens /settings/users by URL as Appearance for a member only", () => {
    expect(itemFromPath("/settings/users", false, "member")).toEqual({
      kind: "settings",
      section: "appearance",
    });
    expect(itemFromPath("/settings/users", false, "owner")).toEqual({ kind: "settings", section: "users" });
  });
});
