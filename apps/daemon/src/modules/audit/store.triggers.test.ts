import { afterEach, describe, expect, it } from "vitest";
import { createAuditStore, type AuditInsert } from "./store.ts";
import { createAuditBed } from "./testing/bed.ts";

const OLD = Date.UTC(2024, 4, 15); // 2024-05
const NOW = Date.now();

let bed: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => bed?.dispose());

const open = () => {
  bed = createAuditBed();
  return { db: bed.db, store: createAuditStore(bed.db) };
};
const row = (overrides: Partial<AuditInsert> = {}): AuditInsert => ({
  at: NOW,
  ownerId: "u1",
  actor: "system",
  kind: "audit",
  decision: "info",
  reason: "x",
  ...overrides,
});

describe("the audit table's guards", () => {
  it("refuses UPDATE and DELETE outside a prune", () => {
    const { db, store } = open();
    store.append(row({ at: OLD }));
    expect(() => db.run("UPDATE audit SET reason = 'x'")).toThrow(/audit is append-only/);
    expect(() => db.run("DELETE FROM audit")).toThrow(/audit is append-only/);
    expect(store.count("2024-05")).toBe(1);
  });

  it("refuses a month that does not match the timestamp", () => {
    const { db } = open();
    expect(() =>
      db.run(
        "INSERT INTO audit (at, month, actor, kind, decision) VALUES ($at, '2023-01', 'system', 'audit', 'info')",
        { at: OLD },
      ),
    ).toThrow(/CHECK/);
  });

  it("prunes a month older than 12 months in one transaction and leaves its own line", () => {
    const { db, store } = open();
    for (let i = 0; i < 3; i++) store.append(row({ at: OLD + i }));
    store.append(row({ at: NOW }));
    expect(store.prune("2024-05", NOW)).toBe(3);
    expect(store.count("2024-05")).toBe(0);
    expect(db.all("SELECT month, state, rows FROM audit_prunes")).toEqual([
      { month: "2024-05", state: "done", rows: 3 },
    ]);
    expect(store.page({ ownerId: null, limit: 10 }).map((r) => [r.kind, r.reason])).toContainEqual([
      "audit",
      "pruned",
    ]);
    expect(() => db.run("UPDATE audit_prunes SET rows = 0")).toThrow(/append-only/);
    expect(() => db.run("DELETE FROM audit_prunes")).toThrow(/append-only/);
  });

  it("refuses to open a prune for last month and for this month, and deletes nothing", () => {
    const { store } = open();
    store.append(row({ at: NOW }));
    const lastMonth = new Date(NOW);
    lastMonth.setUTCMonth(lastMonth.getUTCMonth() - 1);
    const month = lastMonth.toISOString().slice(0, 7);
    expect(() => store.prune(month, NOW)).toThrow(/older than 12 months/);
    expect(() => store.prune(new Date(NOW).toISOString().slice(0, 7), NOW)).toThrow(/older than 12 months/);
    expect(store.count(new Date(NOW).toISOString().slice(0, 7))).toBe(1);
  });

  it("refuses the month exactly 12 months back and accepts the one before it", () => {
    const { store } = open();
    const monthsBack = (n: number) => {
      const at = new Date(NOW);
      return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() - n, 15));
    };
    store.append(row({ at: monthsBack(12).getTime() }));
    store.append(row({ at: monthsBack(13).getTime() }));
    expect(() => store.prune(monthsBack(12).toISOString().slice(0, 7), NOW)).toThrow(/older than 12 months/);
    expect(store.prune(monthsBack(13).toISOString().slice(0, 7), NOW)).toBe(1);
    expect(store.count(monthsBack(12).toISOString().slice(0, 7))).toBe(1);
  });

  it("refuses a prune row that is born done and a prune closed twice", () => {
    const { db, store } = open();
    expect(() => db.run("INSERT INTO audit_prunes (month, state, at) VALUES ('2024-05', 'done', 1)")).toThrow(
      /older than 12 months/,
    );
    store.append(row({ at: OLD }));
    store.prune("2024-05", NOW);
    expect(() => db.run("UPDATE audit_prunes SET state = 'done', rows = 9")).toThrow(/append-only/);
  });
});
