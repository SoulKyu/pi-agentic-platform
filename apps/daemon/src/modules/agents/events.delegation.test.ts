import { AGENT_EVENT_LIMITS } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentEvents } from "./events.ts";
import { type AgentsBed, createAgentsBed } from "./testing/bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());

const ATLAS = "atlas-0000";
const SCOUT = "scout-0001";
const LIMIT = AGENT_EVENT_LIMITS.delegationChars;

function setup() {
  bed = createAgentsBed();
  for (const [id, name] of [
    [ATLAS, "Atlas"],
    [SCOUT, "Scout"],
  ] as const)
    bed.db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ($id, 'u1', $name, lower($name), '{"name":"x"}', 1, 1)`,
      { id, name },
    );
  const bump = vi.fn();
  const written = vi.fn();
  const events = createAgentEvents({
    db: bed.db,
    clock: bed.clock,
    logger: { warn: vi.fn() } as never,
    unread: { bump },
    written,
  });
  return { events, bump, written };
}
const rows = () =>
  bed.db.all<{ kind: string; agent_id: string; task_id: string | null; data: string }>(
    "SELECT kind, agent_id, task_id, data FROM agent_events ORDER BY id",
  );
const result = (over: Partial<Parameters<ReturnType<typeof createAgentEvents>["delegation"]>[3]> = {}) => ({
  fromAgentId: SCOUT,
  fromName: "Scout",
  state: "done" as const,
  summary: "Three issues are open.",
  tainted: false,
  isolated: false,
  ...over,
});

describe("the delegation's result card (M11R79)", () => {
  it("writes one card of kind delegation in the requester's thread and counts it unread once", () => {
    const { events, bump } = setup();
    expect(events.delegation("u1", ATLAS, "task-1", result())).toBe(true);
    const [row] = rows();
    expect(row).toMatchObject({ kind: "delegation", agent_id: ATLAS, task_id: "task-1" });
    expect(JSON.parse(row?.data ?? "")).toEqual({ ...result(), clipped: false });
    expect(bump).toHaveBeenCalledTimes(1);
    expect(bump).toHaveBeenCalledWith("u1", ATLAS);
  });

  it("carries the tainted and the isolated marks as given", () => {
    const { events } = setup();
    events.delegation("u1", ATLAS, "task-1", result({ tainted: true, isolated: true, state: "failed" }));
    expect(JSON.parse(rows()[0]?.data ?? "")).toMatchObject({
      tainted: true,
      isolated: true,
      state: "failed",
    });
  });

  it("strips hidden characters and clips to 16 000 units, saying it was clipped", () => {
    const { events } = setup();
    events.delegation("u1", ATLAS, "task-1", result({ summary: "ok\u202e\u200b\u0007 done\ttab\nline" }));
    expect(JSON.parse(rows()[0]?.data ?? "")).toMatchObject({
      summary: "ok done\ttab\nline",
      clipped: false,
    });
    events.delegation("u1", ATLAS, "task-2", result({ summary: "é".repeat(LIMIT + 1) }));
    const clipped = JSON.parse(rows()[1]?.data ?? "") as { summary: string; clipped: boolean };
    expect(clipped.summary).toHaveLength(LIMIT);
    expect(clipped.clipped).toBe(true);
    events.delegation("u1", ATLAS, "task-3", result({ summary: "x".repeat(LIMIT) }));
    expect(JSON.parse(rows()[2]?.data ?? "")).toMatchObject({ clipped: false });
  });

  it("never cuts a pair of units in half: an astral character at the edge goes whole or not at all", () => {
    const { events } = setup();
    events.delegation("u1", ATLAS, "task-1", result({ summary: `${"a".repeat(LIMIT - 1)}\u{1F600}` }));
    const stored = JSON.parse(rows()[0]?.data ?? "") as { summary: string; clipped: boolean };
    expect(stored.summary).toBe("a".repeat(LIMIT - 1));
    expect(stored.clipped).toBe(true);
  });

  it("takes a run with no assistant text: the summary is empty", () => {
    const { events } = setup();
    events.delegation("u1", ATLAS, "task-1", result({ summary: null }));
    expect(JSON.parse(rows()[0]?.data ?? "")).toMatchObject({ summary: "", clipped: false });
  });

  it("writes nothing for another owner's requester or one that is gone, and for a state with no card", () => {
    const { events, bump } = setup();
    expect(events.delegation("u2", ATLAS, "task-1", result())).toBe(false);
    expect(events.delegation("u1", "ghost-0000", "task-1", result())).toBe(false);
    expect(events.delegation("u1", ATLAS, "task-1", result({ state: "bogus" as never }))).toBe(false);
    expect(rows()).toEqual([]);
    expect(bump).not.toHaveBeenCalled();
  });
});

describe("the reminder's card (M11R80)", () => {
  it("writes the note and the time it was set, in the thread it fires in", () => {
    const { events, bump } = setup();
    expect(events.reminder("u1", ATLAS, "task-1", { note: "Check the build", setAt: 1234 })).toBe(true);
    const [row] = rows();
    expect(row).toMatchObject({ kind: "reminder", agent_id: ATLAS, task_id: "task-1" });
    expect(JSON.parse(row?.data ?? "")).toEqual({ note: "Check the build", setAt: 1234 });
    expect(bump).toHaveBeenCalledTimes(1);
  });

  it("strips hidden characters from the note and clips it to 2 000 units", () => {
    const { events } = setup();
    events.reminder("u1", ATLAS, "task-1", { note: `a\u202eb${"x".repeat(3000)}`, setAt: 1 });
    const stored = JSON.parse(rows()[0]?.data ?? "") as { note: string };
    expect(stored.note).toHaveLength(AGENT_EVENT_LIMITS.noteChars);
    expect(stored.note.startsWith("abx")).toBe(true);
  });
});

describe("the delegation request's card in the target's thread (M11R71)", () => {
  const request = {
    fromAgentId: ATLAS,
    fromName: "Atlas",
    state: "running" as const,
    summary: "Check the board",
    tainted: false,
    isolated: false,
  };
  it("is written running with the request, then moved to the state the task ended with; the requester's own card is left alone", () => {
    const { events, bump } = setup();
    events.delegation("u1", SCOUT, "task-1", request);
    events.delegation("u1", ATLAS, "task-1", result());
    expect(bump).toHaveBeenCalledTimes(2);
    expect(events.delegationEnded("u1", SCOUT, "task-1", "done")).toBe(true);
    const [mine, theirs] = rows();
    expect(JSON.parse(mine?.data ?? "")).toMatchObject({
      fromAgentId: ATLAS,
      state: "done",
      summary: "Check the board",
    });
    expect(theirs?.agent_id).toBe(ATLAS);
    expect(JSON.parse(theirs?.data ?? "")).toMatchObject({ fromAgentId: SCOUT, state: "done" });
    expect(bump).toHaveBeenCalledTimes(2);
  });

  it("counts a failure unread again, and does nothing for a card that is not there", () => {
    const { events, bump } = setup();
    events.delegation("u1", SCOUT, "task-1", request);
    expect(events.delegationEnded("u1", SCOUT, "task-1", "failed")).toBe(true);
    expect(bump).toHaveBeenCalledTimes(2);
    expect(events.delegationEnded("u1", SCOUT, "task-9", "done")).toBe(false);
    expect(events.delegationEnded("u2", SCOUT, "task-1", "done")).toBe(false);
  });

  it("a boot-time settle moves a card that still runs, and a second one changes nothing: no unread, no hint", () => {
    const { events, bump, written } = setup();
    events.delegation("u1", SCOUT, "task-1", request);
    bump.mockClear();
    written.mockClear();
    const only = { whileRunning: true } as const;
    expect(events.delegationEnded("u1", SCOUT, "task-1", "failed", only)).toBe(true);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledTimes(1);
    expect(events.delegationEnded("u1", SCOUT, "task-1", "failed", only)).toBe(false);
    expect(events.delegationEnded("u1", SCOUT, "task-1", "done", only)).toBe(false);
    expect(bump).toHaveBeenCalledTimes(1);
    expect(written).toHaveBeenCalledTimes(1);
    expect(JSON.parse(rows()[0]?.data ?? "")).toMatchObject({ state: "failed" });
  });
});
