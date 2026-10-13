import { describe, expect, it } from "vitest";
import {
  applyMark,
  isSnoozed,
  MAX_PINS,
  markStateOf,
  type MarkOutcome,
  type Marks,
  NO_MARKS,
  SNOOZE_MAX_MS,
  SNOOZE_MIN_MS,
} from "./marks.ts";

const NOW = 1_800_000_000_000;
const HOUR = 3_600_000;
const ok = (outcome: MarkOutcome) => {
  if (!outcome.ok) throw new Error(`refused: ${outcome.code}`);
  return outcome;
};
const fifty = Array.from({ length: MAX_PINS }, (_, i) => `p${i}`);

describe("applyMark (M4R15)", () => {
  it("pins last, before another pin, and moves a pinned session", () => {
    expect(applyMark("s", NO_MARKS, { kind: "pin", before: null }, ["a", "b"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, pinRank: 3 },
      pins: ["a", "b", "s"],
    });
    expect(ok(applyMark("s", NO_MARKS, { kind: "pin", before: "b" }, ["a", "b"], NOW)).pins).toEqual([
      "a",
      "s",
      "b",
    ]);
    expect(
      applyMark("b", { ...NO_MARKS, pinRank: 2 }, { kind: "pin", before: "a" }, ["a", "b"], NOW),
    ).toEqual({
      ok: true,
      marks: { ...NO_MARKS, pinRank: 1 },
      pins: ["b", "a"],
    });
    expect(ok(applyMark("s", NO_MARKS, { kind: "pin", before: "gone" }, ["a"], NOW)).pins).toEqual([
      "a",
      "s",
    ]);
  });

  it("refuses a 51st pin and still moves one of the 50", () => {
    expect(applyMark("s", NO_MARKS, { kind: "pin", before: null }, fifty, NOW)).toEqual({
      ok: false,
      code: "limit_reached",
    });
    expect(
      ok(applyMark("p3", { ...NO_MARKS, pinRank: 4 }, { kind: "pin", before: "p0" }, fifty, NOW)).marks
        .pinRank,
    ).toBe(1);
  });

  it("pinning brings an archived or settled session back into view and keeps its snooze", () => {
    const marks: Marks = {
      ...NO_MARKS,
      archivedAt: 1,
      settledAt: 2,
      settledAuto: true,
      snoozedUntil: NOW + HOUR,
    };
    expect(ok(applyMark("s", marks, { kind: "pin", before: null }, [], NOW)).marks).toEqual({
      ...marks,
      pinRank: 1,
      archivedAt: null,
      settledAt: null,
      settledAuto: false,
    });
  });

  it("unpins; archive and settle unpin too and clear the snooze", () => {
    const pinned: Marks = { ...NO_MARKS, pinRank: 1, snoozedUntil: NOW + HOUR };
    expect(applyMark("s", pinned, { kind: "unpin" }, ["s", "b"], NOW)).toEqual({
      ok: true,
      marks: { ...pinned, pinRank: null },
      pins: ["b"],
    });
    expect(applyMark("s", pinned, { kind: "archive" }, ["s"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, archivedAt: NOW },
      pins: [],
    });
    expect(applyMark("s", pinned, { kind: "settle" }, ["s"], NOW)).toEqual({
      ok: true,
      marks: { ...NO_MARKS, settledAt: NOW },
      pins: [],
    });
    expect(ok(applyMark("s", NO_MARKS, { kind: "unpin" }, ["b"], NOW)).pins).toBeNull();
  });

  it("keeps the first archive and settle times; a manual settle replaces an automatic one", () => {
    expect(
      ok(applyMark("s", { ...NO_MARKS, archivedAt: 5 }, { kind: "archive" }, [], NOW)).marks.archivedAt,
    ).toBe(5);
    expect(
      ok(applyMark("s", { ...NO_MARKS, settledAt: 6, settledAuto: true }, { kind: "settle" }, [], NOW)).marks,
    ).toEqual({
      ...NO_MARKS,
      settledAt: 6,
    });
  });

  it("unarchives; unsettle records its time for the 3-day rule", () => {
    expect(ok(applyMark("s", { ...NO_MARKS, archivedAt: 5 }, { kind: "unarchive" }, [], NOW)).marks).toEqual(
      NO_MARKS,
    );
    expect(
      ok(applyMark("s", { ...NO_MARKS, settledAt: 6, settledAuto: true }, { kind: "unsettle" }, [], NOW))
        .marks,
    ).toEqual({
      ...NO_MARKS,
      unsettledAt: NOW,
    });
  });

  it("snoozes from one minute to 366 days ahead, never an archived session, and wakes", () => {
    const refused = { ok: false, code: "bad_request" };
    expect(applyMark("s", NO_MARKS, { kind: "snooze", until: NOW + SNOOZE_MIN_MS - 1 }, [], NOW)).toEqual(
      refused,
    );
    expect(applyMark("s", NO_MARKS, { kind: "snooze", until: NOW + SNOOZE_MAX_MS + 1 }, [], NOW)).toEqual(
      refused,
    );
    expect(
      applyMark("s", { ...NO_MARKS, archivedAt: 1 }, { kind: "snooze", until: NOW + HOUR }, [], NOW),
    ).toEqual(refused);
    expect(
      ok(
        applyMark(
          "s",
          { ...NO_MARKS, settledAt: 1 },
          { kind: "snooze", until: NOW + SNOOZE_MAX_MS },
          [],
          NOW,
        ),
      ).marks,
    ).toEqual({
      ...NO_MARKS,
      snoozedUntil: NOW + SNOOZE_MAX_MS,
    });
    expect(
      ok(applyMark("s", { ...NO_MARKS, snoozedUntil: NOW + 1 }, { kind: "wake" }, [], NOW)).marks,
    ).toEqual(NO_MARKS);
  });

  it("restores what Undo captured: the place among the pins, archive, settle and snooze", () => {
    const before: Marks = { ...NO_MARKS, pinRank: 2, snoozedUntil: NOW + HOUR };
    const pins = ["a", "s", "b"];
    const state = markStateOf("s", before, pins, NOW);
    expect(state).toEqual({
      pinned: true,
      pinBefore: "b",
      archived: false,
      settled: false,
      snoozedUntil: NOW + HOUR,
    });
    const archived = ok(applyMark("s", before, { kind: "archive" }, pins, NOW));
    expect(
      applyMark("s", archived.marks, { kind: "restore", state }, archived.pins ?? pins, NOW + 1000),
    ).toEqual({
      ok: true,
      marks: before,
      pins,
    });
  });

  it("restore drops a snooze whose time has passed and refuses a pin past the limit", () => {
    const state = { pinned: false, pinBefore: null, archived: false, settled: false, snoozedUntil: NOW - 1 };
    expect(ok(applyMark("s", NO_MARKS, { kind: "restore", state }, [], NOW)).marks.snoozedUntil).toBeNull();
    expect(
      applyMark("s", NO_MARKS, { kind: "restore", state: { ...state, pinned: true } }, fifty, NOW),
    ).toEqual({
      ok: false,
      code: "limit_reached",
    });
  });

  it("isSnoozed compares with now", () => {
    expect([null, NOW, NOW + 1].map((snoozedUntil) => isSnoozed({ snoozedUntil }, NOW))).toEqual([
      false,
      false,
      true,
    ]);
  });
});
