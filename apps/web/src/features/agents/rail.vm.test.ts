import type { AgentSummary } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { t } from "../../i18n/index.ts";
import { agentAt, agentTarget, badgeText, nextUnread, railName, railPresence } from "./rail.vm.ts";

const agent = (id: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id.split("-")[0] ?? id,
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

describe("the rail's badge text (M11R108)", () => {
  it("shows the count up to 99 and 99+ past it", () => {
    expect([0, 1, 99, 100, 1000].map(badgeText)).toEqual(["0", "1", "99", "99+", "99+"]);
  });
});

describe("the rail's accessible name (M11R108: the state is a word, never a colour)", () => {
  it("names the agent, the state and the unread count", () => {
    const atlas = agent("atlas-1a2b", { name: "Atlas", state: "needs_input", unread: 3 });
    expect(railName(atlas, t)).toBe("Atlas, needs input, 3 unread");
  });

  it("leaves the unread part out when nothing is unread, and says 99+ past 99", () => {
    expect(railName(agent("atlas-1a2b", { name: "Atlas", state: "running" }), t)).toBe("Atlas, working");
    expect(railName(agent("atlas-1a2b", { name: "Atlas", state: "idle", unread: 250 }), t)).toBe(
      "Atlas, 99+ unread",
    );
  });

  it("says each state with its lifecycle word, and nothing for a ready agent", () => {
    const words = (["needs_input", "running", "failed", "paused", "idle", "quarantined"] as const).map(
      (state) => railName(agent("atlas-1a2b", { name: "Atlas", state }), t),
    );
    expect(words).toEqual([
      "Atlas, needs input",
      "Atlas, working",
      "Atlas, failed",
      "Atlas, paused",
      "Atlas",
      "Atlas, quarantined",
    ]);
  });

  it("names an unreadable profile and the fix", () => {
    const broken = agent("atlas-1a2b", { name: "Atlas", state: "paused", unreadable: true });
    expect(railName(broken, t)).toBe("Atlas, paused, profile unreadable, opens Settings › Agents");
  });
});

describe("the presence dot", () => {
  it("maps the six states onto the three dots", () => {
    expect(
      (["needs_input", "running", "failed", "paused", "idle", "quarantined"] as const).map(railPresence),
    ).toEqual(["waiting", "running", "waiting", "idle", "idle", "idle"]);
  });
});

describe("the order and the shortcuts (M11R108, M11R109)", () => {
  const list = [
    agent("atlas-1a2b"),
    agent("bolt-0001", { unread: 2 }),
    agent("cato-0002"),
    agent("dino-0003", { unread: 1 }),
  ];

  it("keeps the order the daemon sent, which is the creation order", () => {
    expect(agentAt(list, 1)?.id).toBe("atlas-1a2b");
    expect(agentAt(list, 4)?.id).toBe("dino-0003");
  });

  it("has no n-th agent past the end or below one", () => {
    expect([agentAt(list, 5), agentAt(list, 0), agentAt([], 1)]).toEqual([null, null, null]);
  });

  it("finds the next agent with unread after the active one, wrapping", () => {
    expect(nextUnread(list, "atlas-1a2b", 1)?.id).toBe("bolt-0001");
    expect(nextUnread(list, "bolt-0001", 1)?.id).toBe("dino-0003");
    expect(nextUnread(list, "dino-0003", 1)?.id).toBe("bolt-0001");
  });

  it("finds the previous one the other way, wrapping", () => {
    expect(nextUnread(list, "dino-0003", -1)?.id).toBe("bolt-0001");
    expect(nextUnread(list, "bolt-0001", -1)?.id).toBe("dino-0003");
    expect(nextUnread(list, "atlas-1a2b", -1)?.id).toBe("dino-0003");
  });

  it("starts from the edge when no agent is active, and finds nothing when nothing is unread", () => {
    expect(nextUnread(list, null, 1)?.id).toBe("bolt-0001");
    expect(nextUnread(list, null, -1)?.id).toBe("dino-0003");
    expect(nextUnread([agent("atlas-1a2b"), agent("bolt-0001")], null, 1)).toBeNull();
  });

  it("does not step onto the active agent when it is the only one with unread", () => {
    const only = [agent("atlas-1a2b", { unread: 4 }), agent("bolt-0001")];
    expect(nextUnread(only, "atlas-1a2b", 1)).toBeNull();
    expect(nextUnread(only, null, 1)?.id).toBe("atlas-1a2b");
  });
});

describe("where an avatar leads", () => {
  it("opens the agent's tab, or Settings › Agents when the profile cannot be read", () => {
    expect(agentTarget(agent("atlas-1a2b"))).toEqual({ kind: "agent", id: "atlas-1a2b" });
    expect(agentTarget(agent("atlas-1a2b", { unreadable: true }))).toEqual({
      kind: "settings",
      section: "agents",
    });
  });
});
