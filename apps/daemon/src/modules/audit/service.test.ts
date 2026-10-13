import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "../../testing/caller.ts";
import { createAuditModule } from "./index.ts";
import { createAuditService } from "./service.ts";
import { createAuditStore, type AuditInsert } from "./store.ts";
import { createAuditBed } from "./testing/bed.ts";

let current: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => current?.dispose());

function bed() {
  current = createAuditBed();
  const { db, clock, logger, lines, failWrites } = current;
  const module = createAuditModule({ db, clock, logger });
  const store = createAuditStore(db);
  const service = createAuditService({ store, clock, logger });
  return { module, service, list: service, store, clock, lines, failWrites };
}
const currentMonth = (clock: { now(): number }) => new Date(clock.now()).toISOString().slice(0, 7);
const row = (overrides: Partial<AuditInsert> = {}): AuditInsert => ({
  at: Date.now(),
  ownerId: "u1",
  actor: "system",
  kind: "audit",
  decision: "info",
  reason: "x",
  ...overrides,
});
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

describe("audit service", () => {
  it("stores a worker's call entry with its stages, redacted args and the session's owner", () => {
    const { service, store } = bed();
    const entry = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "approved",
      reason: "answer: once",
      stages: [{ stage: "01", outcome: "pass" }],
      args: "ls",
    };
    expect(service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" })).toEqual(entry);
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      actor: "worker",
      kind: "call",
      sessionId: "s1",
      ownerId: "u1",
      tool: "bash",
      decision: "approved",
      args: "ls",
    });
  });

  it("stores a result entry with its counts in detail", () => {
    const { service, store } = bed();
    const entry = { kind: "result", toolCallId: "c", tool: "web", stages: [], redactions: 2, external: true };
    service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      kind: "result",
      decision: "info",
      detail: { redactions: 2, external: true },
    });
  });

  it("appends the daemon's scope fact to stage 05 of a session entry", () => {
    const { service, store } = bed();
    service.fromWorker({ id: "s1", ownerId: "u1" }, sessionEntry(), { containment: "scope" });
    const stages = store.page({ ownerId: "u1", limit: 1 })[0]?.stages;
    expect(stages?.find((v) => v.stage === "05")?.reason).toBe(
      "no sandbox profile for interactive sessions; worker scope on",
    );
    service.fromWorker({ id: "s1", ownerId: "u1" }, sessionEntry(), { containment: "none" });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]?.stages.find((v) => v.stage === "05")?.reason).toBe(
      "no sandbox profile for interactive sessions; worker scope off",
    );
  });

  it("stores one invalid row for a malformed record and logs it once a minute", async () => {
    const { service, store, lines, clock } = bed();
    for (let i = 0; i < 5; i++)
      expect(
        service.fromWorker({ id: "s1", ownerId: "u1" }, { kind: "call", tool: 7 }, { containment: "none" }),
      ).toBeNull();
    expect(store.page({ ownerId: "u1", limit: 10 }).map((r) => r.kind)).toEqual([
      "invalid",
      "invalid",
      "invalid",
      "invalid",
      "invalid",
    ]);
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      reason: "malformed audit record",
      args: null,
      actor: "worker",
      sessionId: "s1",
    });
    expect(lines.filter((l) => l.msg === "audit_record_invalid")).toHaveLength(1);
    await clock.advance(60_000);
    service.fromWorker({ id: "s1", ownerId: "u1" }, null, { containment: "none" });
    expect(lines.filter((l) => l.msg === "audit_record_invalid")).toHaveLength(2);
  });

  it("stores at most 100 invalid rows per session, then only counts them (M5R46)", async () => {
    const { service, store, lines, clock } = bed();
    for (let i = 0; i < 150; i++)
      service.fromWorker({ id: "s1", ownerId: "u1" }, { kind: "call", tool: i }, { containment: "none" });
    service.fromWorker({ id: "s2", ownerId: "u1" }, { kind: "x" }, { containment: "none" });
    expect(store.count(currentMonth(clock))).toBe(101);
    await clock.advance(60_000);
    service.fromWorker({ id: "s1", ownerId: "u1" }, { kind: "x" }, { containment: "none" });
    expect(lines.filter((l) => l.msg === "audit_record_invalid").at(-1)).toMatchObject({
      sessionId: "s1",
      dropped: 51,
    });
  });

  it("keeps the invalid counters of at most 1024 sessions, the oldest dropped", () => {
    const { service, store, clock } = bed();
    for (let i = 0; i < 100; i++)
      service.fromWorker({ id: "first", ownerId: "u1" }, 1, { containment: "none" });
    for (let i = 0; i < 1024; i++)
      service.fromWorker({ id: `s${i}`, ownerId: "u1" }, 1, { containment: "none" });
    // "first" fell out of the map, so its budget starts again.
    service.fromWorker({ id: "first", ownerId: "u1" }, 1, { containment: "none" });
    expect(store.count(currentMonth(clock))).toBe(100 + 1024 + 1);
  });

  it("fits a session entry's tools into detail: 256 names of 256 characters keep their count (M5R123)", () => {
    const { service, store } = bed();
    const tools = Array.from(
      { length: 256 },
      (_, i) => `mcp__server__${String(i).padStart(3, "0")}_${"x".repeat(239)}`,
    );
    service.fromWorker(
      { id: "s1", ownerId: "u1" },
      { ...sessionEntry(), tools, toolsTruncated: false },
      { containment: "none" },
    );
    const detail = store.page({ ownerId: "u1", limit: 1 })[0]?.detail as {
      count: number;
      truncated: boolean;
      names: string[];
    };
    expect(detail.count).toBe(256);
    expect(detail.truncated).toBe(true);
    expect(JSON.stringify(detail).length).toBeLessThanOrEqual(4_000);
    expect(detail.names).toEqual(tools.slice(0, detail.names.length));
    expect(detail.names.length).toBe(15);
  });

  it("scrubs well-known token formats from a worker's arguments and reason before storing them (M5R124)", () => {
    const { service, store } = bed();
    const entry = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "approved",
      reason: `answer: once ghp_${"c".repeat(36)}`,
      stages: [],
      args: `curl -H "Authorization: Bearer ${"a".repeat(30)}" -d ghp_${"b".repeat(36)}`,
    };
    service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" });
    const stored = store.page({ ownerId: "u1", limit: 1 })[0];
    expect(stored?.args).toBe('curl -H "Authorization: [REDACTED:bearer]" -d [REDACTED:github_token]');
    expect(stored?.reason).toBe("answer: once [REDACTED:github_token]");
  });

  it("clips a reason that grew past the column's limit after the scrub", () => {
    const { service, store } = bed();
    const entry = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "allow",
      reason: "AKIAIOSFODNN7EXAMPLE ".repeat(48),
      stages: [],
      args: "",
    };
    expect(service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" })).not.toBeNull();
    expect(store.page({ ownerId: "u1", limit: 1 })[0]?.reason).toHaveLength(1024);
  });

  it("says at boot when months can be pruned, and is quiet otherwise (M5R125)", () => {
    const { module, store, clock } = bed();
    expect(module.prunableAtBoot(clock.now())).toBeNull();
    store.append(row({ at: Date.UTC(2024, 4, 15) }));
    store.append(row({ at: Date.UTC(2024, 6, 1) }));
    expect(module.prunableAtBoot(clock.now())).toEqual({ months: 2, oldest: "2024-05" });
  });

  it("never throws when the database refuses the row", () => {
    const { service, failWrites, lines } = bed();
    failWrites();
    expect(() =>
      service.append({ ownerId: "u1", actor: "user", kind: "auth", reason: "token_created" }),
    ).not.toThrow();
    expect(() =>
      service.append({ ownerId: "u1", actor: "user", kind: "auth", reason: "token_created" }),
    ).not.toThrow();
    expect(
      service.fromWorker({ id: "s1", ownerId: "u1" }, { kind: "x" }, { containment: "none" }),
    ).toBeNull();
    // Kind only, no reason or payload, and once a minute.
    expect(lines.filter((l) => l.msg === "audit_append_failed")).toEqual([
      expect.objectContaining({ kind: "auth" }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("token_created");
  });

  it("stores an auth line with its actor, detail and no session", () => {
    const { service, store } = bed();
    service.append({
      ownerId: "u1",
      actor: "token",
      actorId: "t1",
      kind: "auth",
      reason: "token_created",
      detail: { name: "ci", ttl: 3600 },
    });
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      actor: "token",
      actorId: "t1",
      kind: "auth",
      decision: "info",
      reason: "token_created",
      sessionId: null,
      detail: { name: "ci", ttl: 3600 },
    });
  });

  it("pages newest first under the frame, the caller's rows and the system's only", () => {
    const { service, list } = bed();
    for (let i = 0; i < 250; i++)
      service.append({ ownerId: "u1", actor: "user", kind: "policy", reason: `r${i}` });
    service.append({ ownerId: "u2", actor: "user", kind: "policy", reason: "other" });
    service.append({ ownerId: null, actor: "system", kind: "audit", reason: "pruned" });
    const first = list.list(testCaller(), { limit: 200 });
    expect(first.entries).toHaveLength(200);
    expect(first.entries[0]?.reason).toBe("pruned");
    expect(first.entries.some((e) => e.reason === "other")).toBe(false);
    const next = list.list(testCaller(), { limit: 200, before: first.nextBefore ?? 0 });
    expect(next.entries).toHaveLength(51);
    expect(next.nextBefore).toBeNull();
    expect(list.list(testCaller(), {}).entries).toHaveLength(100);
  });

  it("cuts a page that would not fit the frame and says so", () => {
    const { service, list } = bed();
    const entry = {
      kind: "call",
      toolCallId: "c",
      tool: "bash",
      category: "exec",
      decision: "allow",
      reason: "r".repeat(1024),
      stages: Array(8).fill({ stage: "01", outcome: "pass", reason: "s".repeat(256) }),
      args: "a".repeat(4_112),
    };
    for (let i = 0; i < 200; i++)
      service.fromWorker({ id: "s1", ownerId: "u1" }, entry, { containment: "none" });
    const page = list.list(testCaller(), { limit: 200 });
    expect(page.truncated).toBe(true);
    expect(page.nextBefore).toBe(page.entries.at(-1)?.id);
    const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
    expect(size(page)).toBeLessThanOrEqual(900_000);
    // Exactly as many as fit: the next row would not.
    const next = list.list(testCaller(), { limit: 1, before: page.nextBefore ?? 0 }).entries[0];
    expect(size(page) + size(next) + 1).toBeGreaterThan(900_000);
  });
});
