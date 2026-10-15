import { describe, expect, it } from "vitest";
import { checkpointTarget, MAX_TURN_PATH, turnRanges } from "./turn-range.ts";

interface Entry {
  id: string;
  parentId: string | null;
  user: boolean;
  preview: string;
}

/** A chain: each id is the child of the one before it; ids starting with `u` are user messages. */
function chain(ids: readonly string[]): Entry[] {
  return ids.map((id, at) => ({
    id,
    parentId: at === 0 ? null : (ids[at - 1] ?? null),
    user: id.startsWith("u"),
    preview: `preview ${id}`,
  }));
}

const THREE_TURNS = chain(["u1", "a1", "u2", "a2", "u3", "a3", "a4"]);

describe("turnRanges (M9R57)", () => {
  it("starts a turn at each user message and ends it at the last checkpoint inside it", () => {
    const turns = turnRanges(THREE_TURNS, new Set(["root", "a1", "a4"]));
    expect(turns).toEqual([
      { index: 1, userEntryId: "u1", preview: "preview u1", from: "root", to: "a1" },
      { index: 2, userEntryId: "u2", preview: "preview u2", from: "a1", to: "live" },
      { index: 3, userEntryId: "u3", preview: "preview u3", from: "a1", to: "a4" },
    ]);
  });

  it("takes the nearest checkpoint at or before the entry before the next user message", () => {
    const turns = turnRanges(THREE_TURNS, new Set(["root", "a1", "a2", "a3"]));
    expect(turns.map((turn) => [turn.from, turn.to])).toEqual([
      ["root", "a1"],
      ["a1", "a2"],
      ["a2", "a3"],
    ]);
  });

  it("ends a turn at live when the only checkpoint at or before its end predates the turn, and at its own user entry never", () => {
    const turns = turnRanges(THREE_TURNS, new Set(["root", "u2"]));
    expect(turns[1]).toMatchObject({ from: "root", to: "live" });
  });

  it("has no start when nothing is checkpointed before the turn", () => {
    const turns = turnRanges(THREE_TURNS, new Set(["a4"]));
    expect(turns[0]).toMatchObject({ from: null, to: "live" });
    expect(turns[2]).toMatchObject({ from: null, to: "a4" });
  });

  it("finds the checkpoints of the source of a fork, which share their entry ids", () => {
    const source = chain(["u1", "a1", "u2", "a2"]);
    const fork = [...source.slice(0, 2), { id: "u9", parentId: "a1", user: true, preview: "forked" }];
    const turns = turnRanges(fork, new Set(["root", "a1"]));
    expect(turns).toEqual([
      { index: 1, userEntryId: "u1", preview: "preview u1", from: "root", to: "a1" },
      { index: 2, userEntryId: "u9", preview: "forked", from: "a1", to: "live" },
    ]);
  });

  it("answers an empty path with no turns", () => {
    expect(turnRanges([], new Set(["root"]))).toEqual([]);
  });

  it("cuts a branch of 10 001 entries at 10 000, the oldest first, and does not throw", () => {
    const ids = Array.from({ length: MAX_TURN_PATH + 1 }, (_, at) => `u${at}`);
    const turns = turnRanges(chain(ids), new Set(["u9999"]));
    expect(turns).toHaveLength(MAX_TURN_PATH);
    expect(turns[0]?.userEntryId).toBe("u1");
    expect(turns[0]?.from).toBeNull();
    expect(turns[MAX_TURN_PATH - 1]).toMatchObject({ userEntryId: `u${MAX_TURN_PATH}`, to: "live" });
  });
});

describe("checkpointTarget (M9R57)", () => {
  it("is exact only when the leaf itself has a checkpoint", () => {
    expect(checkpointTarget(THREE_TURNS, new Set(["a4"]))).toEqual({ entryId: "a4", turn: 3, exact: true });
    expect(checkpointTarget(THREE_TURNS, new Set(["a1", "a2"]))).toEqual({
      entryId: "a2",
      turn: 2,
      exact: false,
    });
  });

  it("falls back to root, then to nothing", () => {
    expect(checkpointTarget(THREE_TURNS, new Set(["root"]))).toEqual({
      entryId: null,
      turn: null,
      exact: false,
    });
    expect(checkpointTarget(THREE_TURNS, new Set())).toBeNull();
  });

  it("is root and exact for an empty path that has a root checkpoint", () => {
    expect(checkpointTarget([], new Set(["root"]))).toEqual({ entryId: null, turn: null, exact: true });
  });
});
