import { beforeEach, describe, expect, it } from "vitest";
import { EMPTY_WORKSPACE, useWorkspaceStore } from "../../features/workspace/index.ts";
import { activePath, pathOfDestination } from "./landing-route.ts";

beforeEach(() => useWorkspaceStore.setState({ ws: EMPTY_WORKSPACE }));

describe("pathOfDestination", () => {
  it("maps each destination to the page the router knows", () => {
    expect(pathOfDestination({ kind: "session", id: "s1" })).toBe("/s/s1");
    expect(pathOfDestination({ kind: "agent", id: "helper-1a2b" })).toBe("/agents/helper-1a2b");
    expect(pathOfDestination({ kind: "settings", section: "automation" })).toBe("/settings/automation");
    expect(pathOfDestination({ kind: "settings", section: "notifications" })).toBe("/settings/notifications");
    expect(pathOfDestination({ kind: "inbox", itemId: "q1" })).toBe("/");
    expect(pathOfDestination({ kind: "inbox", itemId: null })).toBe("/");
  });

  it("refuses ids that are not what the router takes as data (M12R33)", () => {
    for (const destination of [
      { kind: "session", id: "a/b" },
      { kind: "session", id: ".." },
      { kind: "session", id: "x".repeat(129) },
      { kind: "agent", id: "not an agent id" },
      { kind: "inbox", itemId: "a/b" },
      { kind: "inbox", itemId: "x".repeat(129) },
    ] as const)
      expect(pathOfDestination(destination), JSON.stringify(destination)).toBeNull();
  });

  it("opens the Inbox over the active tab", () => {
    useWorkspaceStore.getState().open({ kind: "session", id: "s1" });
    expect(activePath()).toBe("/s/s1");
    expect(pathOfDestination({ kind: "inbox", itemId: null })).toBe("/s/s1");
  });
});
