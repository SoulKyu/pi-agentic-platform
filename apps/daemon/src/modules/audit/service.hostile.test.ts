import { methods } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createAuditService } from "./service.ts";
import { createAuditStore } from "./store.ts";
import { createAuditBed } from "./testing/bed.ts";

let current: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => current?.dispose());

function bed() {
  current = createAuditBed();
  const { db, clock, logger, lines, failWrites } = current;
  const store = createAuditStore(db);
  const service = createAuditService({ store, clock, logger });
  return { service, list: service, store, clock, lines, failWrites };
}
const currentMonth = (clock: { now(): number }) => new Date(clock.now()).toISOString().slice(0, 7);
const sessionEntry = () => ({
  kind: "session",
  stages: [
    { stage: "00", outcome: "pass" },
    { stage: "05", outcome: "skip", reason: "no sandbox profile for interactive sessions" },
  ],
  tools: ["bash", "read"],
  toolsTruncated: false,
  mode: "auto-accept-edits",
});

describe("audit service against hostile entries and floods", () => {
  it("never lets a worker blind the viewer: a 256-character stage 05 reason keeps the daemon's fact whole (I1)", () => {
    const { service, list, store } = bed();
    const entry = {
      ...sessionEntry(),
      stages: [{ stage: "05", outcome: "skip", reason: "w".repeat(256) }],
    };
    service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" });
    const reason = store.page({ ownerId: "u1", limit: 1 })[0]?.stages[0]?.reason ?? "";
    expect(reason).toHaveLength(256);
    expect(reason.endsWith("; worker scope off")).toBe(true);
    const page = list.list(testCaller(), {});
    expect(methods["audit.list"].result.parse(page)).toEqual(page);
    expect(page.entries).toHaveLength(1);
  });

  it("lists a row whose stages are valid JSON of the wrong shape with none (I1)", () => {
    const { service, list, store, lines } = bed();
    service.append({ ownerId: "u1", actor: "user", kind: "policy", reason: "a" });
    service.append({ ownerId: "u1", actor: "user", kind: "policy", reason: "b" });
    current?.db.exec("DROP TRIGGER audit_no_update");
    current?.db.exec("UPDATE audit SET stages = '[1]', detail = '[5]'");
    expect(store.page({ ownerId: "u1", limit: 1 })[0]?.stages).toEqual([]);
    const page = list.list(testCaller(), {});
    expect(page.entries.map((e) => [e.reason, e.stages, e.detail])).toEqual([
      ["b", [], null],
      ["a", [], null],
    ]);
    expect(methods["audit.list"].result.parse(page)).toEqual(page);
    expect(lines.filter((l) => l.msg === "audit_row_degraded")).toHaveLength(0);
  });

  it("degrades a row the contract refuses instead of failing the page: an empty session id (I1)", () => {
    const { service, list, lines } = bed();
    service.append({ ownerId: "u1", actor: "user", kind: "policy", reason: "ok" });
    service.append({ ownerId: "u1", actor: "user", kind: "policy", reason: "empty", sessionId: "" });
    const page = list.list(testCaller(), {});
    expect(page.entries.map((e) => [e.reason, e.sessionId])).toEqual([
      ["empty", null],
      ["ok", null],
    ]);
    expect(methods["audit.list"].result.parse(page)).toEqual(page);
    expect(lines.filter((l) => l.msg === "audit_row_degraded")).toHaveLength(1);
  });

  it("fits stages whose escaped reasons pass 4 096 characters by clipping reasons, keeping ids and outcomes (M1)", () => {
    const { service, store } = bed();
    const verdicts = (["00", "01", "02", "03", "04", "05", "06", "07"] as const).map((stage) => ({
      stage,
      outcome: "ask",
      reason: '"'.repeat(256),
    }));
    const entry = {
      kind: "result",
      toolCallId: "c",
      tool: "t",
      stages: verdicts,
      redactions: 0,
      external: false,
    };
    expect(service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" })).not.toBeNull();
    const stored = store.page({ ownerId: "u1", limit: 1 })[0];
    expect(stored?.kind).toBe("result");
    expect(stored?.stages.map((v) => [v.stage, v.outcome])).toEqual(
      verdicts.map((v) => [v.stage, v.outcome]),
    );
    expect(JSON.stringify(stored?.stages).length).toBeLessThanOrEqual(4_096);
    expect(stored?.stages.every((v) => (v.reason ?? "").length > 0)).toBe(true);
  });

  it("stores a call entry whose every field is at its contract maximum (M3)", () => {
    const { service, store } = bed();
    const entry = {
      kind: "call",
      toolCallId: "i".repeat(256),
      parentToolCallId: "p".repeat(256),
      tool: "t".repeat(256),
      category: "exec",
      decision: "allow",
      reason: "r".repeat(1024),
      stages: Array(8).fill({ stage: "01", outcome: "pass", reason: "s".repeat(200) }),
      args: "a".repeat(4_112),
    };
    expect(service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" })).not.toBeNull();
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      kind: "call",
      args: "a".repeat(4_112),
    });
  });

  it("replaces NUL in every worker string, keeps bidi characters, keeps duplicate stage ids (M3)", () => {
    const { service, store } = bed();
    const entry = {
      kind: "call",
      toolCallId: "c\u0000d",
      tool: "ba\u0000sh",
      category: "exec",
      decision: "allow",
      reason: "re\u0000ason \u202Eevil",
      stages: [
        { stage: "01", outcome: "pass", reason: "a\u0000b" },
        { stage: "01", outcome: "ask", reason: "dup" },
      ],
      args: "ls\u0000 -l",
    };
    service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" });
    const stored = store.page({ ownerId: "u1", limit: 1 })[0];
    expect(stored).toMatchObject({
      toolCallId: "c\uFFFDd",
      tool: "ba\uFFFDsh",
      reason: "re\uFFFDason \u202Eevil",
      args: "ls\uFFFD -l",
    });
    expect(stored?.stages).toEqual([
      { stage: "01", outcome: "pass", reason: "a\uFFFDb" },
      { stage: "01", outcome: "ask", reason: "dup" },
    ]);
    const names = { ...sessionEntry(), tools: ["to\u0000ol"] };
    service.fromWorker({ id: "s1", ownerId: "u1" }, names, { containment: "none" });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]?.detail).toMatchObject({ names: ["to\uFFFDol"] });
  });

  it("keeps the session's mode in detail, before the tool names (M5)", () => {
    const { service, store } = bed();
    service.fromWorker({ id: "s1", ownerId: "u1" }, sessionEntry(), { containment: "none" });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]?.detail).toEqual({
      count: 2,
      truncated: false,
      mode: "auto-accept-edits",
      names: ["bash", "read"],
    });
  });

  it("budgets 600 worker rows per session per minute and marks the gap at its first drop (M6)", async () => {
    const { service, store, clock, lines } = bed();
    const call = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "allow",
      stages: [],
      args: "",
    };
    for (let i = 0; i < 700; i++)
      service.fromWorker({ id: "s1", ownerId: "u1" }, call, { containment: "none" });
    service.fromWorker({ id: "s2", ownerId: "u1" }, call, { containment: "none" });
    expect(store.count(currentMonth(clock))).toBe(602);
    expect(lines.filter((l) => l.msg === "audit_rows_dropped")).toMatchObject([
      { sessionId: "s1", dropped: 1 },
    ]);
    await clock.advance(60_000);
    service.fromWorker({ id: "s1", ownerId: "u1" }, call, { containment: "none" });
    expect(lines.filter((l) => l.msg === "audit_rows_dropped")).toMatchObject([
      { sessionId: "s1", dropped: 1 },
      { sessionId: "s1", dropped: 100 },
    ]);
    const rows = store.page({ ownerId: "u1", limit: 4 });
    expect(rows.map((r) => r.reason)).toEqual([null, null, "audit rows dropped: rate limit", null]);
    expect(rows[2]).toMatchObject({ actor: "worker", sessionId: "s1", kind: "audit", decision: "info" });
    expect(store.count(currentMonth(clock))).toBe(603);
  });

  it("writes the marker for a session that goes quiet, once per window", async () => {
    const { service, store, clock } = bed();
    const call = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "allow",
      stages: [],
      args: "",
    };
    const markers = () => store.page({ ownerId: "u1", limit: 5000 }).filter((r) => r.kind === "audit");
    for (let i = 0; i < 600; i++)
      service.fromWorker({ id: "s1", ownerId: "u1" }, call, { containment: "none" });
    expect(markers()).toHaveLength(0);
    service.fromWorker({ id: "s1", ownerId: "u1" }, call, { containment: "none" });
    // The session says nothing more: the gap is already on record, where it began.
    expect(markers()).toMatchObject([{ sessionId: "s1", reason: "audit rows dropped: rate limit" }]);
    for (let i = 0; i < 50; i++)
      service.fromWorker({ id: "s1", ownerId: "u1" }, call, { containment: "none" });
    expect(markers()).toHaveLength(1);
    await clock.advance(60_000);
    for (let i = 0; i < 601; i++)
      service.fromWorker({ id: "s1", ownerId: "u1" }, call, { containment: "none" });
    expect(markers()).toHaveLength(2);
  });

  it("keeps the row budgets of at most 1024 sessions and logs the count of one it forgets (M6)", () => {
    const { service, store, clock, lines } = bed();
    const call = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "allow",
      stages: [],
      args: "",
    };
    for (let i = 0; i < 602; i++)
      service.fromWorker({ id: "first", ownerId: "u1" }, call, { containment: "none" });
    for (let i = 0; i < 1024; i++)
      service.fromWorker({ id: `s${i}`, ownerId: "u1" }, call, { containment: "none" });
    // "first" was forgotten with 2 drops: one marker, written at the first, and the count in the log.
    expect(store.page({ ownerId: "u1", limit: 2000 }).filter((r) => r.kind === "audit")).toMatchObject([
      { sessionId: "first", detail: null },
    ]);
    expect(lines.filter((l) => l.msg === "audit_rows_dropped")).toMatchObject([
      { sessionId: "first", dropped: 1 },
      { sessionId: "first", dropped: 2 },
    ]);
    service.fromWorker({ id: "first", ownerId: "u1" }, call, { containment: "none" });
    expect(store.count(currentMonth(clock))).toBe(600 + 1 + 1024 + 1);
  });

  it("counts the failures it did not log in the next line (M10)", async () => {
    const { service, failWrites, lines, clock } = bed();
    failWrites();
    for (let i = 0; i < 4; i++) service.append({ ownerId: "u1", actor: "user", kind: "auth", reason: "x" });
    await clock.advance(60_000);
    service.append({ ownerId: "u1", actor: "user", kind: "auth", reason: "x" });
    expect(lines.filter((l) => l.msg === "audit_append_failed").map((l) => l.suppressed)).toEqual([0, 3]);
  });
});
