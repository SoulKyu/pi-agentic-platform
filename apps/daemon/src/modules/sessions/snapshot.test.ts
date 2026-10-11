import { type Dialog, SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import {
  fitSnapshot,
  PARTIAL_BYTES,
  ROW_BYTES,
  SNAPSHOT_BYTES,
  SNAPSHOT_ROWS,
  withTrimmedHistory,
} from "./snapshot.ts";

const sizeOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const message = (n: number, filler = "") => ({ role: "user", content: `m${n}${filler}` });
const row = (n: number, filler = "") => ({ entryId: `e${n}`, message: message(n, filler) });
const dialog = (id: string, filler = ""): Dialog => ({
  id,
  method: "confirm",
  title: `Run ${id}?`,
  message: filler,
});

describe("fitSnapshot", () => {
  it("carries the status, the rows and the open dialogs as they are when they fit", () => {
    const rows = [row(1), row(2)];
    expect(fitSnapshot({ status: "idle", rows, dialogs: [dialog("d1")] })).toEqual({
      kind: "snapshot",
      status: "idle",
      rows,
      dialogs: [dialog("d1")],
      partial: null,
      queue: { steering: [], followUp: [], count: 0, bytes: 0 },
      statuses: [],
      widgets: [],
      title: null,
      panels: [],
      notices: [],
      decorationsTruncated: false,
      history: { hasMore: false, oldestEntryId: null, turnsBefore: 0 },
      activity: { compacting: false, retry: null },
      leafId: null,
      name: null,
    });
  });

  it("keeps the newest rows, at most SNAPSHOT_ROWS of them", () => {
    const rows = Array.from({ length: SNAPSHOT_ROWS + 10 }, (_, i) => row(i));
    const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [] });
    expect(snapshot.rows).toHaveLength(SNAPSHOT_ROWS);
    expect(snapshot.rows.at(-1)).toEqual(row(SNAPSHOT_ROWS + 9));
  });

  it("drops the oldest rows first until the event fits the budget", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, "x".repeat(1000)));
    const snapshot = fitSnapshot({ status: "running", rows, dialogs: [] }, 3500);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(3500);
    expect(snapshot.rows.length).toBeGreaterThan(0);
    expect(snapshot.rows.at(-1)).toEqual(rows.at(-1));
    expect(snapshot.rows[0]).toEqual(rows[10 - snapshot.rows.length]);
  });

  it("keeps rows contiguous: a row that does not fit ends the history there", () => {
    const rows = [row(1), row(2, "x".repeat(5000)), row(3)];
    const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [] }, 1000);
    expect(snapshot.rows).toEqual([row(3)]);
  });

  it("gives the open dialogs the room first, oldest first, and leaves out those that do not fit", () => {
    const dialogs = [
      dialog("d1", "a".repeat(400)),
      dialog("d2", "b".repeat(400)),
      dialog("d3", "c".repeat(400)),
    ];
    const rows = [row(1), row(2)];
    const snapshot = fitSnapshot({ status: "running", rows, dialogs }, 1500);
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1", "d2"]);
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(1500);
  });

  it("stays under the default budget with the largest dialogs the registry allows", () => {
    const dialogs = Array.from({ length: 64 }, (_, i) => dialog(`d${i}`, "x".repeat(60_000)));
    const snapshot = fitSnapshot({ status: "running", rows: [row(1)], dialogs });
    expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    expect(SNAPSHOT_BYTES + 512).toBeLessThan(1024 * 1024);
  });

  describe("a row over the per-row budget (R109)", () => {
    const huge = (n: number) => ({ role: "toolResult", timestamp: n, content: "x".repeat(ROW_BYTES + 10) });
    const hugeRow = (n: number) => ({ entryId: `h${n}`, message: huge(n) });

    it("never empties the snapshot: the newest row becomes a placeholder and the older rows stay", () => {
      const rows = [row(1), row(2), hugeRow(3)];
      const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [] });
      expect(snapshot.rows).toEqual([
        row(1),
        row(2),
        {
          entryId: "h3",
          message: { role: "toolResult", timestamp: 3, omitted: true, bytes: sizeOf(hugeRow(3)) },
        },
      ]);
    });

    it("says what it can of a row that has no role or timestamp", () => {
      const snapshot = fitSnapshot({
        status: "idle",
        rows: [{ entryId: null, message: "x".repeat(ROW_BYTES + 10) }],
        dialogs: [],
      });
      expect(snapshot.rows).toEqual([
        {
          entryId: null,
          message: { role: "unknown", timestamp: null, omitted: true, bytes: ROW_BYTES + 39 },
        },
      ]);
    });

    it("clips a role to 64 characters, and takes a role that is not text for unknown", () => {
      const pathological = { role: "r".repeat(100_000), timestamp: 1, content: "x".repeat(ROW_BYTES + 10) };
      const snapshot = fitSnapshot({
        status: "idle",
        rows: [
          { entryId: null, message: pathological },
          { entryId: null, message: { role: { not: "text" }, content: "x".repeat(ROW_BYTES + 10) } },
        ],
        dialogs: [],
      });
      const [first, second] = snapshot.rows.map((r) => r.message as { role: string });
      expect(first?.role).toBe("r".repeat(64));
      expect(second?.role).toBe("unknown");
      expect(sizeOf(snapshot)).toBeLessThan(1000);
    });

    it("keeps a placeholder a run already made as it is", () => {
      const placeholder = {
        entryId: "p3",
        message: { role: "toolResult", timestamp: 3, omitted: true, bytes: 999_999 },
      };
      const snapshot = fitSnapshot({ status: "idle", rows: [row(1), placeholder], dialogs: [] });
      expect(snapshot.rows).toEqual([row(1), placeholder]);
    });

    it("still ends the history at the first row that does not fit the rest of the budget", () => {
      const rows = Array.from({ length: 6 }, (_, i) => ({
        entryId: `e${i}`,
        message: { role: "user", content: "y".repeat(ROW_BYTES - 100), i },
      }));
      const snapshot = fitSnapshot({ status: "idle", rows, dialogs: [] });
      expect(snapshot.rows.length).toBeLessThan(6);
      expect(snapshot.rows.at(-1)).toEqual(rows.at(-1));
      expect(sizeOf(snapshot)).toBeLessThanOrEqual(SNAPSHOT_BYTES);
    });
  });

  it("always carries the small sections, then dialogs, panels and the partial before rows", () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({
      entryId: `e${i}`,
      message: { role: "user", content: "x".repeat(300_000) },
    }));
    const snapshot = fitSnapshot({
      status: "running",
      rows,
      dialogs: [{ id: "d1", method: "confirm", title: "ok?" }],
      panels: [{ id: "p1", lines: ["> a"] }],
      partial: { blocks: [{ type: "text", text: "Hel" }] },
      statuses: [{ key: "git", text: "main" }],
      name: "n",
    });
    expect(snapshot.statuses).toEqual([{ key: "git", text: "main" }]);
    expect(snapshot.panels.map((panel) => panel.id)).toEqual(["p1"]);
    expect(snapshot.partial?.blocks[0]?.text).toBe("Hel");
    expect(snapshot.rows.map((r) => r.entryId)).toEqual(["e0", "e1", "e2"]);
    expect(snapshot.rows.every((r) => (r.message as { omitted?: boolean }).omitted === true)).toBe(true);
    expect(snapshot.decorationsTruncated).toBe(false);
  });

  it("leaves out a partial reply over PARTIAL_BYTES", () => {
    const partial = { blocks: [{ type: "text" as const, text: "y".repeat(PARTIAL_BYTES) }] };
    expect(fitSnapshot({ status: "running", rows: [], dialogs: [], partial }).partial).toBeNull();
  });

  it("keeps a pending approval and stays under the frame budget with ANSI-heavy widgets (M2-RT-05)", () => {
    // 51 × "\u001b[31mx\u001b[0m" = 510 characters, 1 020 JSON bytes: an ESC weighs 6 bytes once encoded.
    const line = "\u001b[31mx\u001b[0m".repeat(51);
    const widgets = Array.from({ length: UI_LIMITS.widgets }, (_, i) => ({
      key: `w${i}`,
      lines: Array.from({ length: UI_LIMITS.widgetLines }, () => line),
      placement: "aboveEditor" as const,
    }));
    const editor = { id: "e1", method: "editor" as const, title: "Edit", prefill: "p".repeat(999_500) };
    const approval = {
      id: "a1",
      method: "approval" as const,
      title: "Run a command?",
      message: "1 line\nbash: ls",
      category: "exec" as const,
      answers: ["deny", "once"] as Array<"deny" | "once">,
    };
    const snapshot = fitSnapshot({ status: "running", rows: [], dialogs: [editor, approval], widgets });
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["a1"]);
    // Each widget is 51 195 JSON bytes: five fit in DECORATION_BYTES, the newest three are left out.
    expect(snapshot.widgets.map((widget) => widget.key)).toEqual(["w0", "w1", "w2", "w3", "w4"]);
    expect(snapshot.decorationsTruncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(SNAPSHOT_BYTES);
  });

  it("keeps the other dialogs in their original order after the approvals", () => {
    const approval = { id: "a1", method: "approval" as const, title: "Run?", category: "exec" as const };
    const snapshot = fitSnapshot({
      status: "running",
      rows: [],
      dialogs: [dialog("d1"), approval, dialog("d2")],
    });
    expect(snapshot.dialogs.map((d) => d.id)).toEqual(["d1", "a1", "d2"]);
  });

  it("keeps the newest notices when there are too many for DECORATION_BYTES", () => {
    const notices = Array.from({ length: UI_LIMITS.notices }, (_, i) => ({
      level: "info" as const,
      text: `${i}`.padEnd(UI_LIMITS.noticeText, "n"),
    }));
    const snapshot = fitSnapshot({ status: "idle", rows: [], dialogs: [], notices }, 5000);
    expect(snapshot.notices.map((n) => n.text.slice(0, 2).trim())).toEqual(["18", "19"]);
    expect(snapshot.decorationsTruncated).toBe(true);
  });

  it("builds snapshots the contract parses, whatever the inputs hold (M2-RT-06)", () => {
    const snapshot = fitSnapshot({
      status: "idle",
      rows: [{ entryId: "e1", message: { role: "user", content: "\u0000\u202e".repeat(400_000) } }],
      dialogs: [],
      statuses: Array.from({ length: UI_LIMITS.statuses }, (_, i) => ({
        key: `k${i}`,
        text: "名".repeat(UI_LIMITS.statusText),
      })),
      notices: Array.from({ length: UI_LIMITS.notices }, () => ({
        level: "info" as const,
        text: "é".repeat(UI_LIMITS.noticeText),
      })),
      title: "t".repeat(UI_LIMITS.title),
      name: "n".repeat(UI_LIMITS.name),
      leafId: "e".repeat(128),
    });
    expect(SessionStreamEvent.safeParse(snapshot).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(snapshot))).toBeLessThanOrEqual(SNAPSHOT_BYTES);
  });
});

describe("withTrimmedHistory", () => {
  const anchor = (n: number, role = "user") => ({ entryId: `e${n}`, message: { role, content: `m${n}` } });
  const page = { hasMore: false, oldestEntryId: "e1", turnsBefore: 0 };

  it("passes the page's own history when nothing was left out", () => {
    const offered = [anchor(1), anchor(2)];
    const snapshot = fitSnapshot({ status: "idle", rows: offered, dialogs: [] });
    expect(withTrimmedHistory(snapshot, offered, { ...page, hasMore: true, turnsBefore: 4 }).history).toEqual(
      {
        hasMore: true,
        oldestEntryId: "e1",
        turnsBefore: 4,
      },
    );
  });

  it("points the history at the oldest row kept and counts the turns left out above it", () => {
    const offered = [
      anchor(1, "assistant"),
      anchor(2, "user"),
      anchor(3, "compactionSummary"),
      anchor(4, "toolResult"),
      ...Array.from({ length: SNAPSHOT_ROWS }, (_, i) => anchor(10 + i, "assistant")),
    ];
    const snapshot = fitSnapshot({ status: "idle", rows: offered, dialogs: [] });
    expect(snapshot.rows).toHaveLength(SNAPSHOT_ROWS);
    expect(withTrimmedHistory(snapshot, offered, { ...page, turnsBefore: 5 }).history).toEqual({
      hasMore: true,
      oldestEntryId: "e10",
      turnsBefore: 7,
    });
  });

  it("skips kept rows that have no entry id yet when it names the oldest", () => {
    const offered = [
      anchor(1),
      { entryId: null, message: { role: "assistant" } },
      ...Array.from({ length: SNAPSHOT_ROWS - 1 }, (_, i) => anchor(10 + i, "assistant")),
    ];
    const snapshot = fitSnapshot({ status: "idle", rows: offered, dialogs: [] });
    expect(snapshot.rows[0]?.entryId).toBeNull();
    expect(withTrimmedHistory(snapshot, offered, page).history).toEqual({
      hasMore: true,
      oldestEntryId: "e10",
      turnsBefore: 1,
    });
  });

  it("falls back to the page's oldest id when no row kept has one", () => {
    const offered = [
      anchor(1),
      ...Array.from({ length: SNAPSHOT_ROWS }, () => ({ entryId: null, message: { role: "assistant" } })),
    ];
    const snapshot = fitSnapshot({ status: "idle", rows: offered, dialogs: [] });
    expect(withTrimmedHistory(snapshot, offered, page).history).toEqual({
      hasMore: true,
      oldestEntryId: "e1",
      turnsBefore: 1,
    });
  });
});
