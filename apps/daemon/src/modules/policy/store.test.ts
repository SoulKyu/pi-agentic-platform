import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPolicyService } from "./service.ts";
import { createPolicyStore, type RuleRow } from "./store.ts";
import { createPolicyBed, KEY, keyOf } from "./testing/bed.ts";

let bed: ReturnType<typeof makeBed>;
const makeBed = () => {
  const base = createPolicyBed();
  const store = createPolicyStore(base.db);
  const service = createPolicyService({
    store,
    clock: base.clock,
    logger: base.logger,
    newId: base.newId,
    audit: base.audit,
  });
  return { ...base, store, service };
};
beforeEach(() => {
  bed = makeBed();
});
afterEach(() => bed.dispose());

const row = (id: string, over: Partial<RuleRow> = {}): RuleRow => ({
  id,
  ownerId: "u1",
  scope: "/w",
  tool: "bash",
  grantKey: KEY,
  label: "l",
  createdAt: 1,
  ...over,
});

describe("policy store", () => {
  it("refuses a second identical rule and sees the first", () => {
    const { store } = bed;
    expect(store.insert(row("a"))).toBe(true);
    expect(store.insert(row("b"))).toBe(false);
    expect(store.exists("u1", "/w", "bash", KEY)).toBe(true);
    expect(store.exists("u1", "/w", "read", KEY)).toBe(false);
    expect(store.exists("u2", "/w", "bash", KEY)).toBe(false);
    expect(store.count("u1", "/w")).toBe(1);
    // The same call is a different rule for another owner, project or tool.
    expect(store.insert(row("c", { ownerId: "u2" }))).toBe(true);
    expect(store.insert(row("d", { scope: "/x" }))).toBe(true);
    expect(store.insert(row("e", { tool: "read" }))).toBe(true);
  });

  it("orders a project's rules by creation and bounds the read", () => {
    const { store } = bed;
    store.insert(row("b", { grantKey: keyOf(2), createdAt: 20 }));
    store.insert(row("a", { grantKey: keyOf(1), createdAt: 10 }));
    store.insert(row("c", { grantKey: keyOf(3), createdAt: 30 }));
    expect(store.forScope("u1", "/w", 10).map((r) => r.id)).toEqual(["a", "b", "c"]);
    expect(store.forScope("u1", "/w", 2).map((r) => r.id)).toEqual(["a", "b"]);
    expect(store.newest("u1", null, 2).map((r) => r.id)).toEqual(["c", "b"]);
  });

  it("removes only the owner's own rule", () => {
    const { store } = bed;
    store.insert(row("a"));
    expect(store.remove("u2", "a")).toBe(false);
    expect(store.get("u2", "a")).toBeUndefined();
    expect(store.get("u1", "a")?.grantKey).toBe(KEY);
    expect(store.remove("u1", "a")).toBe(true);
    expect(store.remove("u1", "a")).toBe(false);
  });

  it("refuses a grant key that is not 64 characters", () => {
    expect(() => bed.store.insert(row("a", { grantKey: "short" }))).toThrow();
  });
});
