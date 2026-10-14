import { describe, expect, it } from "vitest";
import {
  Dialog,
  DialogResponse,
  EMPTY_QUEUE,
  IDLE_ACTIVITY,
  NO_HISTORY,
  SERVER_CODES,
  Notice,
  Panel,
  SessionName,
  SessionStreamEvent,
  SessionSummary,
  StatusEntry,
  UI_LIMITS,
} from "./index.ts";

const approval = {
  id: "a1",
  method: "approval",
  title: "Run a command?",
  message: "1 line\nbash: ls",
  category: "exec",
};

describe("session stream v2 schemas (additive)", () => {
  it("opens an approval with distinct answers only", () => {
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "session", "always", "once"] }).success).toBe(
      true,
    );
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "deny"] }).success).toBe(false);
    expect(Dialog.safeParse({ ...approval, answers: ["deny"] }).success).toBe(false);
  });

  it("refuses an approval without a category or without answers", () => {
    expect(Dialog.safeParse({ ...approval }).success).toBe(false);
    expect(Dialog.safeParse({ ...approval, answers: [] }).success).toBe(false);
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "once"], category: undefined }).success).toBe(
      false,
    );
    expect(Dialog.safeParse({ ...approval, answers: ["deny", "once"] }).success).toBe(true);
    expect(Dialog.safeParse({ id: "d1", method: "confirm", title: "Run?" }).success).toBe(true);
  });

  it("answers an approval with one of four answers", () => {
    expect(DialogResponse.safeParse({ answer: "always" }).success).toBe(true);
    expect(DialogResponse.safeParse({ answer: "forever" }).success).toBe(false);
  });

  it("bounds what extensions put on screen", () => {
    expect(StatusEntry.safeParse({ key: "k", text: "x".repeat(UI_LIMITS.statusText + 1) }).success).toBe(
      false,
    );
    const lines = Array.from({ length: UI_LIMITS.panelLines + 1 }, () => "x");
    expect(Panel.safeParse({ id: "p", lines }).success).toBe(false);
    expect(Notice.safeParse({ level: "info", text: "hi", source: "extension" }).success).toBe(true);
    expect(Notice.safeParse({ level: "info", text: "hi", source: "someone" }).success).toBe(false);
  });

  it("starts the defaults empty", () => {
    expect(EMPTY_QUEUE).toEqual({ steering: [], followUp: [], count: 0, bytes: 0 });
    expect(NO_HISTORY).toEqual({ hasMore: false, oldestEntryId: null, turnsBefore: 0 });
  });
});

const snapshot = {
  kind: "snapshot",
  status: "releasing",
  rows: [
    { entryId: "e1", message: { role: "user", content: "hi" } },
    { entryId: null, message: {} },
  ],
  dialogs: [{ ...approval, answers: ["deny", "session", "always", "once"] }],
  partial: {
    blocks: [
      { type: "text", text: "Hel" },
      { type: "toolCall", text: '{"pa', id: "c1", name: "read" },
    ],
  },
  queue: { steering: ["go left"], followUp: [], count: 1, bytes: 7 },
  statuses: [{ key: "command:/mode build", text: "Build" }],
  widgets: [{ key: "todo", lines: ["- a"], placement: "belowEditor" }],
  title: "pi - repo",
  panels: [{ id: "p1", lines: ["> alpha", "  beta"] }],
  notices: [
    { level: "warning", text: "An extension failed during session_start." },
    { level: "info", text: "saved", source: "extension" },
  ],
  hiddenDialogs: 0,
  decorationsTruncated: false,
  history: { hasMore: true, oldestEntryId: "e1", turnsBefore: 3 },
  activity: { compacting: false, retry: { attempt: 1, maxAttempts: 3 } },
  leafId: "e9",
  name: "Fix the login bug",
  policy: { mode: "supervised", explicit: true, tainted: false, defaultMode: "auto-accept-edits" },
};

describe("session stream v2", () => {
  it("reads a snapshot without a policy view as the default one (M5R3)", () => {
    const bare: Record<string, unknown> = { ...snapshot };
    delete bare.policy;
    const parsed = SessionStreamEvent.parse(bare);
    expect(parsed.kind === "snapshot" && parsed.policy).toEqual({
      mode: "auto-accept-edits",
      explicit: false,
      tainted: false,
      defaultMode: "auto-accept-edits",
    });
  });

  it("carries a policy event and a tainted approval with its guard rule", () => {
    expect(
      SessionStreamEvent.safeParse({
        kind: "policy",
        policy: { mode: "read-only", explicit: true, tainted: false },
      }).success,
    ).toBe(true);
    const dialog = { ...approval, answers: ["deny", "once"], tainted: true, guard: "tool-calls" };
    expect(Dialog.parse(dialog)).toMatchObject({ tainted: true, guard: "tool-calls" });
    expect(Dialog.safeParse({ ...dialog, guard: "loops" }).success).toBe(false);
  });

  it("parses a snapshot with every section", () => {
    expect(SessionStreamEvent.parse(snapshot)).toEqual({
      ...snapshot,
      cwd: "",
      outsideWrite: false,
      loadout: null,
      toolPreset: "configured",
    });
  });

  it("carries the session's folder, empty from an older daemon, at most 4096 characters", () => {
    expect(SessionStreamEvent.parse(snapshot)).toMatchObject({ cwd: "" });
    expect(SessionStreamEvent.parse({ ...snapshot, cwd: "/w/api" })).toMatchObject({ cwd: "/w/api" });
    expect(SessionStreamEvent.safeParse({ ...snapshot, cwd: "x".repeat(4097) }).success).toBe(false);
    expect(SessionStreamEvent.safeParse({ ...snapshot, cwd: "x".repeat(4096) }).success).toBe(true);
  });

  it("says whether the Pi file changed outside pap, false from an older daemon (owner Q13)", () => {
    expect(SessionStreamEvent.parse(snapshot)).toMatchObject({ outsideWrite: false });
    expect(SessionStreamEvent.parse({ ...snapshot, outsideWrite: true })).toMatchObject({
      outsideWrite: true,
    });
  });

  it("refuses sections over their limits", () => {
    const statuses = Array.from({ length: UI_LIMITS.statuses + 1 }, (_, i) => ({ key: `k${i}`, text: "x" }));
    expect(SessionStreamEvent.safeParse({ ...snapshot, statuses }).success).toBe(false);
    expect(
      SessionStreamEvent.safeParse({ ...snapshot, title: "t".repeat(UI_LIMITS.title + 1) }).success,
    ).toBe(false);
    expect(
      SessionStreamEvent.safeParse({ kind: "status", status: "cold", cause: "c".repeat(257) }).success,
    ).toBe(false);
  });

  it.each([
    {
      kind: "row",
      row: { entryId: "c1", message: { role: "compactionSummary", summary: "s", tokensBefore: 10 } },
    },
    {
      kind: "entry",
      entry: { id: "e2", parentId: "e1", type: "message", role: "assistant", messageTimestamp: 2 },
    },
    { kind: "queue", queue: EMPTY_QUEUE },
    { kind: "status_bar", key: "git", text: null },
    { kind: "widget", key: "todo", widget: null },
    { kind: "title", title: null },
    { kind: "editor_text", text: "prefill" },
    { kind: "panel", panel: { id: "p1", lines: [] } },
    { kind: "panel_closed", id: "p1" },
    { kind: "name", name: null },
    { kind: "activity", activity: IDLE_ACTIVITY },
    { kind: "notice", level: "info", text: "hi", source: "extension" },
  ])("round-trips a $kind event", (event) => {
    expect(SessionStreamEvent.parse(event)).toEqual(event);
  });
});

describe("session names (M2R92)", () => {
  const summary = { id: "s", cwd: "/w", status: "idle", createdAt: 1, updatedAt: 2 } as const;

  it("counts code points: 256 emoji fit everywhere a name goes, 257 do not", () => {
    for (const name of ["x".repeat(256), "😀".repeat(256), null]) {
      expect(SessionSummary.safeParse({ ...summary, name }).success).toBe(true);
      expect(SessionStreamEvent.safeParse({ kind: "name", name }).success).toBe(true);
    }
    for (const name of ["x".repeat(257), "😀".repeat(257), 4, undefined]) {
      expect(SessionSummary.safeParse({ ...summary, name }).success).toBe(false);
    }
    expect(SessionName.safeParse("😀".repeat(257)).success).toBe(false);
  });
});

describe("server texts by code (R128)", () => {
  it("lets a notice carry a code and params next to its English text, and a status its cause's", () => {
    const notice = {
      kind: "notice",
      level: "error",
      text: "An extension failed during tool_call.",
      code: "extension_failed_during",
      params: { event: "tool_call" },
    };
    expect(SessionStreamEvent.parse(notice)).toEqual(notice);
    const status = {
      kind: "status",
      status: "cold",
      cause: "Agent process exited with code 70.",
      causeCode: "process_exit_code",
      causeParams: { code: "70" },
    };
    expect(SessionStreamEvent.parse(status)).toEqual(status);
    expect(
      Notice.parse({ level: "warning", text: "x", code: "rules_full", params: { max: "200" } }).code,
    ).toBe("rules_full");
  });

  it("keeps the code optional, so a newer web still reads an older daemon", () => {
    expect(SessionStreamEvent.parse({ kind: "notice", level: "info", text: "hi" })).toEqual({
      kind: "notice",
      level: "info",
      text: "hi",
    });
    expect(SessionStreamEvent.parse({ kind: "status", status: "cold", cause: "c" })).toEqual({
      kind: "status",
      status: "cold",
      cause: "c",
    });
    expect(SessionStreamEvent.parse({ ...snapshot, notices: [{ level: "info", text: "old" }] }).kind).toBe(
      "snapshot",
    );
  });

  it("accepts a code this contract does not list (a newer daemon) and bounds codes and params", () => {
    expect(
      SessionStreamEvent.safeParse({ kind: "notice", level: "info", text: "t", code: "from_the_future" })
        .success,
    ).toBe(true);
    const bad = (extra: object) =>
      SessionStreamEvent.safeParse({ kind: "notice", level: "info", text: "t", ...extra }).success;
    expect(bad({ code: "" })).toBe(false);
    expect(bad({ code: "c".repeat(65) })).toBe(false);
    expect(bad({ code: "x", params: { a: "v".repeat(65) } })).toBe(false);
    expect(bad({ code: "x", params: { a: "1", b: "2", c: "3", d: "4", e: "5" } })).toBe(false);
    expect(bad({ code: "x", params: { a: 1 } })).toBe(false);
  });

  it("lists every code the daemon sends", () => {
    expect(new Set(Object.values(SERVER_CODES)).size).toBe(Object.keys(SERVER_CODES).length);
    expect(SERVER_CODES.messageTooLarge).toBe("message_too_large");
    expect(SERVER_CODES.processExitCode).toBe("process_exit_code");
  });
});
