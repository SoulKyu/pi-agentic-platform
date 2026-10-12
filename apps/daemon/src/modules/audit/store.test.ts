import { afterEach, describe, expect, it } from "vitest";
import { createAuditStore, type AuditInsert } from "./store.ts";
import { createAuditBed } from "./testing/bed.ts";

let bed: ReturnType<typeof createAuditBed> | undefined;
afterEach(() => bed?.dispose());
const open = () => {
  bed = createAuditBed();
  return createAuditStore(bed.db);
};
const row = (overrides: Partial<AuditInsert> = {}): AuditInsert => ({
  at: Date.UTC(2026, 0, 2),
  ownerId: "u1",
  actor: "user",
  kind: "policy",
  decision: "info",
  reason: "r",
  ...overrides,
});

describe("audit store", () => {
  it("pages newest first, by owner (plus the system's rows), session and before", () => {
    const store = open();
    store.append(row({ reason: "a", sessionId: "s1" }));
    store.append(row({ reason: "b", ownerId: "u2" }));
    store.append(row({ reason: "c", ownerId: null }));
    store.append(row({ reason: "d", sessionId: "s2" }));
    expect(store.page({ ownerId: "u1", limit: 10 }).map((r) => r.reason)).toEqual(["d", "c", "a"]);
    expect(store.page({ ownerId: "u1", sessionId: "s1", limit: 10 }).map((r) => r.reason)).toEqual(["a"]);
    expect(store.page({ ownerId: "u1", before: 3, limit: 10 }).map((r) => r.reason)).toEqual(["a"]);
    expect(store.page({ ownerId: "u1", limit: 1 }).map((r) => r.reason)).toEqual(["d"]);
  });

  it("parses stages and detail back, and lists a row whose JSON is damaged with none", () => {
    const store = open();
    store.append(row({ stages: [{ stage: "01", outcome: "pass" }], detail: { count: 1, names: ["a"] } }));
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({
      stages: [{ stage: "01", outcome: "pass" }],
      detail: { count: 1, names: ["a"] },
    });
    // json_valid holds for any JSON, so a damaged row is one that is valid JSON of the wrong shape.
    bed?.db.exec("DROP TRIGGER audit_no_update");
    bed?.db.exec("UPDATE audit SET stages = '5', detail = '[1]'");
    expect(store.page({ ownerId: "u1", limit: 1 })[0]).toMatchObject({ stages: [], detail: null });
  });

  it("counts a month and lists the months before a cutoff, oldest first", () => {
    const store = open();
    store.append(row({ at: Date.UTC(2024, 6, 1) }));
    store.append(row({ at: Date.UTC(2024, 4, 15) }));
    store.append(row({ at: Date.UTC(2024, 4, 16) }));
    expect(store.monthsBefore("2025-01")).toEqual(["2024-05", "2024-07"]);
    expect(store.monthsBefore("2024-05")).toEqual([]);
    expect(store.count("2024-05")).toBe(2);
  });
});
