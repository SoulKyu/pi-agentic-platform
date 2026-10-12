import { type Dialog, SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  fitSnapshot,
  OTHER_DIALOG_BYTES,
  PANEL_BYTES,
  placeholderRow,
  ROW_FLOOR_SHARE,
  SNAPSHOT_BYTES,
  sizeOf,
  withTrimmedHistory,
} from "./snapshot.ts";

const many = <T>(n: number, make: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => make(i));
const widget = (i: number) => ({ key: `w${i}`, lines: ["a"], placement: "aboveEditor" as const });

describe("fitSnapshot counts", () => {
  it("clamps every decoration section to its limit and says so", () => {
    const snapshot = fitSnapshot({
      status: "idle",
      rows: [],
      dialogs: [],
      statuses: many(UI_LIMITS.statuses + 1, (i) => ({ key: `k${i}`, text: "x" })),
      widgets: many(UI_LIMITS.widgets + 1, widget),
      notices: many(UI_LIMITS.notices + 1, (i) => ({ level: "info" as const, text: `n${i}` })),
      panels: many(UI_LIMITS.panels + 1, (i) => ({ id: `p${i}`, lines: ["a"] })),
    });
    expect(snapshot.statuses).toHaveLength(UI_LIMITS.statuses);
    expect(snapshot.widgets).toHaveLength(UI_LIMITS.widgets);
    expect(snapshot.notices).toHaveLength(UI_LIMITS.notices);
    expect(snapshot.notices[0]).toEqual({ level: "info", text: "n1" });
    expect(snapshot.notices.at(-1)).toEqual({ level: "info", text: "n20" });
    expect(snapshot.panels).toHaveLength(UI_LIMITS.panels);
    expect(snapshot.decorationsTruncated).toBe(true);
    expect(SessionStreamEvent.safeParse(snapshot).success).toBe(true);
  });

  it("flags nothing when every section is at its limit exactly", () => {
    const snapshot = fitSnapshot({
      status: "idle",
      rows: [],
      dialogs: [],
      statuses: many(UI_LIMITS.statuses, (i) => ({ key: `k${i}`, text: "x" })),
      widgets: many(UI_LIMITS.widgets, widget),
      notices: many(UI_LIMITS.notices, (i) => ({ level: "info" as const, text: `n${i}` })),
      panels: many(UI_LIMITS.panels, (i) => ({ id: `p${i}`, lines: ["a"] })),
    });
    expect(snapshot.decorationsTruncated).toBe(false);
  });
});

describe("fitSnapshot hidden dialogs", () => {
  const dialog = (id: string, size: number): Dialog => ({
    id,
    method: "editor",
    title: "t",
    prefill: "p".repeat(size),
  });

  it("counts the dialogs that did not fit, so the client knows something is pending", () => {
    const snapshot = fitSnapshot(
      {
        status: "running",
        rows: [],
        dialogs: [dialog("d1", 600_000), dialog("d2", 600_000), dialog("d3", 100)],
      },
      1_000_000,
    );
    // d1 (the oldest) takes the room, d2 does not fit; d3 is small but the non-approval dialogs together stay within
    // OTHER_DIALOG_BYTES, and d1 already counts there (M4R8).
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1"]);
    expect(snapshot.hiddenDialogs).toBe(2);
  });

  it("is 0 when every dialog is in", () => {
    const snapshot = fitSnapshot({ status: "idle", rows: [], dialogs: [dialog("d1", 10)] });
    expect(snapshot.hiddenDialogs).toBe(0);
    expect(fitSnapshot({ status: "idle", rows: [], dialogs: [] }).hiddenDialogs).toBe(0);
  });
});

describe("fitSnapshot worst case", () => {
  const heavy = (n: number) => "\u0001".repeat(n);
  const everything = (dialogs: Dialog[]) => ({
    status: "running" as const,
    dialogs,
    rows: many(75, (i) => ({
      entryId: `e${i}`,
      message: { role: "user", content: "r".repeat(1000), timestamp: i },
    })),
    statuses: many(UI_LIMITS.statuses, (i) => ({ key: `k${i}`, text: heavy(UI_LIMITS.statusText) })),
    widgets: many(UI_LIMITS.widgets, (i) => ({
      key: `w${i}`,
      lines: many(UI_LIMITS.widgetLines, () => heavy(UI_LIMITS.widgetLineChars)),
      placement: "aboveEditor" as const,
    })),
    notices: many(UI_LIMITS.notices, () => ({ level: "info" as const, text: heavy(UI_LIMITS.noticeText) })),
    panels: many(UI_LIMITS.panels, (i) => ({
      id: `p${i}`,
      lines: many(UI_LIMITS.panelLines, () => heavy(UI_LIMITS.panelLineChars)),
    })),
  });

  it("stays under the frame with a pending dialog kept, panels held to their own budget, and rows left", () => {
    const dialog: Dialog = { id: "d1", method: "editor", title: "t", prefill: "p".repeat(100_000) };
    const snapshot = fitSnapshot(everything([dialog]));
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1"]);
    expect(snapshot.hiddenDialogs).toBe(0);
    expect(snapshot.decorationsTruncated).toBe(true);
    expect(snapshot.rows.length).toBeGreaterThan(0);
    expect(sizeOf(snapshot.panels)).toBeLessThanOrEqual(PANEL_BYTES);
    expect(SessionStreamEvent.safeParse(snapshot).success).toBe(true);
  });

  it("counts the dialog that no longer fits instead of dropping it silently", () => {
    const big = (id: string): Dialog => ({ id, method: "editor", title: "t", prefill: "p".repeat(600_000) });
    const snapshot = fitSnapshot(everything([big("d1"), big("d2")]));
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1"]);
    expect(snapshot.hiddenDialogs).toBe(1);
  });
});

describe("rows are never crowded out by an extension's dialogs (M2 final M4)", () => {
  const bound = (n: number) => ({ entryId: `e${n}`, message: { role: "user", content: `m${n}` } });
  const unbound = (n: number, bytes: number) => ({
    entryId: null,
    message: { role: "assistant", timestamp: n, content: [{ type: "text", text: "r".repeat(bytes) }] },
  });
  const extension = (id: string, bytes: number): Dialog => ({
    id,
    method: "editor",
    title: id,
    prefill: "p".repeat(bytes),
  });
  const approval = (id: string, bytes: number): Dialog => ({
    id,
    method: "approval",
    title: id,
    message: "a".repeat(bytes),
    category: "exec",
    answers: ["deny", "once"],
  });

  it("caps the dialogs other than approvals, and counts the rest as hidden", () => {
    const dialogs = [extension("x1", 100_000), extension("x2", 100_000), extension("x3", 100_000)];
    const snapshot = fitSnapshot({ status: "running", rows: [bound(1)], dialogs });
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["x1", "x2"]);
    expect(snapshot.hiddenDialogs).toBe(1);
    expect(OTHER_DIALOG_BYTES).toBe(256 * 1024);
  });

  it("always offers the oldest extension dialog the whole room, so a large one stays answerable after a reload (RT-07)", () => {
    const large = fitSnapshot({
      status: "running",
      rows: [bound(1)],
      dialogs: [extension("x1", 300_000), extension("x2", 1_000)],
    });
    expect(large.dialogs.map((d) => d.id)).toEqual(["x1"]);
    expect(large.hiddenDialogs).toBe(1);
    expect(large.rows).toEqual([bound(1)]);
    // Only the oldest: a large one behind a small one waits for its turn.
    const behind = fitSnapshot({
      status: "running",
      rows: [bound(1)],
      dialogs: [extension("x1", 1_000), extension("x2", 300_000)],
    });
    expect(behind.dialogs.map((d) => d.id)).toEqual(["x1"]);
    expect(behind.hiddenDialogs).toBe(1);
  });

  it("still gives approvals the first claim, whatever the extension dialogs", () => {
    const dialogs = [extension("x1", 200_000), approval("a1", 30_000), extension("x2", 100_000)];
    const snapshot = fitSnapshot({ status: "running", rows: [bound(1)], dialogs });
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["x1", "a1"]);
    expect(snapshot.hiddenDialogs).toBe(1);
    expect(snapshot.rows).toEqual([bound(1)]);
  });

  it("keeps the newest bound row when a run's rows and a dialog fill the budget, and the cursor points at it", () => {
    // 100 000 bytes: the floor is 6 250; the dialog fits under budget - floor; three run rows of 20 000 fit, the fourth
    // does not and goes in as a placeholder, then the page's bound rows.
    const rows = [
      bound(1),
      bound(2),
      bound(3),
      unbound(4, 20_000),
      unbound(5, 20_000),
      unbound(6, 20_000),
      unbound(7, 20_000),
    ];
    const snapshot = fitSnapshot({ status: "running", rows, dialogs: [extension("x1", 30_000)] }, 100_000);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(100_000);
    expect(snapshot.rows.at(-1)).toEqual(rows.at(-1));
    expect(snapshot.rows.some((row) => row.entryId === "e3")).toBe(true);
    const placeholder = snapshot.rows.find((row) => (row.message as { omitted?: boolean }).omitted === true);
    expect(placeholder?.entryId).toBeNull();
    const trimmed = withTrimmedHistory(snapshot, rows, {
      hasMore: false,
      oldestEntryId: "e1",
      turnsBefore: 0,
    });
    expect(snapshot.rows.find((row) => row.entryId !== null)?.entryId).toBe(trimmed.history.oldestEntryId);
  });

  it("reserves the row floor from what the other dialogs may take", () => {
    expect(ROW_FLOOR_SHARE).toBe(16);
    const dialogs = [extension("x1", 60_000)];
    // Budget 64 000: the floor is 4 000, so a 60 000-byte dialog (plus the fixed sections) no longer fits.
    const snapshot = fitSnapshot({ status: "running", rows: [bound(1)], dialogs }, 64_000);
    expect(snapshot.dialogs).toEqual([]);
    expect(snapshot.hiddenDialogs).toBe(1);
    expect(snapshot.rows).toEqual([bound(1)]);
  });

  it("a placeholder stays under 600 bytes even when every character of its source escapes (RT-17)", () => {
    const stand = (message: unknown) => ({ entryId: null, message: placeholderRow(message, 1e15) });
    const escaped = stand({
      role: "\u0001".repeat(64),
      toolCallId: "\u0001".repeat(256),
      timestamp: 8.64e15,
    });
    const longest = stand({ role: "r".repeat(64), toolCallId: "c".repeat(256), timestamp: 8.64e15 });
    expect(escaped.message).toEqual({ role: "unknown", timestamp: 8.64e15, omitted: true, bytes: 1e15 });
    expect(longest.message).toMatchObject({ role: "r".repeat(64), toolCallId: "c".repeat(256) });
    // 75 run rows and the newest bound row (its 128-character id escaped) fit in the floor.
    const boundStand = { entryId: "\u0001".repeat(128), message: placeholderRow({ role: "user" }, 1e15) };
    expect(sizeOf(longest) * 75 + sizeOf(boundStand) + 76).toBeLessThan(1_000_000 / ROW_FLOOR_SHARE);
    expect(Math.max(sizeOf(escaped), sizeOf(longest))).toBeLessThan(600);
  });
});
