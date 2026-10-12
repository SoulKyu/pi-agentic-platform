import { type Dialog, SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fitSnapshot, PANEL_BYTES, SNAPSHOT_BYTES, sizeOf } from "./snapshot.ts";

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
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1", "d3"]);
    expect(snapshot.hiddenDialogs).toBe(1);
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
