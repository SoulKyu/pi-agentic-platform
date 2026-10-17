import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ONCE_LIMITS, createOnceStore, refHash, refOf, SECRET_REF, sameRef } from "./refs.ts";

const salt = Buffer.alloc(32, 7);
const HOUR = 60 * 60_000;

describe("refOf (M11R104)", () => {
  it("has the fixed format whatever the id", () => {
    for (const id of ["a", "0a1b2c3d-0000-4000-8000-0123456789ab", "x".repeat(64)])
      expect(refOf(salt, id)).toMatch(SECRET_REF);
  });

  it("is stable for a request, different per request and per salt", () => {
    expect(refOf(salt, "r1")).toBe(refOf(salt, "r1"));
    expect(refOf(salt, "r1")).not.toBe(refOf(salt, "r2"));
    expect(refOf(salt, "r1")).not.toBe(refOf(randomBytes(32), "r1"));
  });

  it("is not derivable from the request id alone: it holds neither the id nor its plain hash", () => {
    const ref = refOf(salt, "r1");
    expect(ref).not.toContain("r1");
    expect(ref).not.toBe(refOf(Buffer.alloc(32, 0), "r1"));
  });
});

describe("refHash and sameRef", () => {
  it("keeps 64 hex characters that are not the ref", () => {
    const ref = refOf(salt, "r1");
    expect(refHash(ref)).toMatch(/^[0-9a-f]{64}$/);
    expect(refHash(ref)).not.toContain(ref.slice("secret-ref:".length));
  });

  it("tells the same ref from a guessed or another request's one", () => {
    const ref = refOf(salt, "r1");
    expect(sameRef(ref, refOf(salt, "r1"))).toBe(true);
    expect(sameRef(ref, refOf(salt, "r2"))).toBe(false);
    expect(sameRef(ref, `secret-ref:${"0".repeat(32)}`)).toBe(false);
  });
});

describe("the once store (M11R105)", () => {
  const entry = (agentId: string, name: string, sessionId = "s1") => ({
    id: `id-${name}-${agentId}`,
    agentId,
    sessionId,
    name,
    value: `value-${name}-${agentId}`,
  });

  it("holds three per agent and refuses the fourth, never evicting", () => {
    const store = createOnceStore(() => 0);
    expect(ONCE_LIMITS.perAgent).toBe(3);
    for (const n of ["A_ONE", "B_TWO", "C_THREE"])
      expect(store.put(refOf(salt, n), entry("atlas", n))).toBe("ok");
    expect(store.put(refOf(salt, "D_FOUR"), entry("atlas", "D_FOUR"))).toBe("limit_reached");
    expect(store.size()).toBe(3);
    expect(store.forSession("s1").map((each) => each.name)).toEqual(["A_ONE", "B_TWO", "C_THREE"]);
  });

  it("counts per agent: another agent's values are fine", () => {
    const store = createOnceStore(() => 0);
    for (const n of ["A_ONE", "B_TWO", "C_THREE"]) store.put(refOf(salt, n), entry("atlas", n));
    expect(store.put(refOf(salt, "E_FIVE"), entry("bolt", "E_FIVE", "s2"))).toBe("ok");
    expect(store.forSession("s2")).toEqual([
      { id: "id-E_FIVE-bolt", name: "E_FIVE", value: "value-E_FIVE-bolt", expiresAt: ONCE_LIMITS.ttlMs },
    ]);
  });

  it("gives a session its own values only", () => {
    const store = createOnceStore(() => 0);
    store.put(refOf(salt, "a"), entry("atlas", "A_ONE", "s1"));
    store.put(refOf(salt, "b"), entry("atlas", "B_TWO", "s2"));
    expect(store.forSession("s1")).toEqual([
      { id: "id-A_ONE-atlas", name: "A_ONE", value: "value-A_ONE-atlas", expiresAt: ONCE_LIMITS.ttlMs },
    ]);
    expect(store.forSession("nobody")).toEqual([]);
  });

  it("used() forgets exactly the entry with that id, once: a repeat or another id deletes nothing else", () => {
    const store = createOnceStore(() => 0);
    store.put(refOf(salt, "a"), { ...entry("atlas", "A_ONE"), id: "i1", value: "same-value" });
    store.put(refOf(salt, "b"), { ...entry("atlas", "A_ONE"), id: "i2", value: "same-value" });
    expect(store.used("s2", "i1")).toBe(false);
    expect(store.used("s1", "nope")).toBe(false);
    expect(store.used("s1", "i1")).toBe(true);
    expect(store.used("s1", "i1")).toBe(false);
    expect(store.forSession("s1").map((each) => each.id)).toEqual(["i2"]);
    expect(store.used("s1", "i2")).toBe(true);
    expect(store.size()).toBe(0);
  });

  it("forgets a value after 24 hours, and the slot is free again", () => {
    let now = 1000;
    const store = createOnceStore(() => now);
    for (const n of ["A_ONE", "B_TWO", "C_THREE"]) store.put(refOf(salt, n), entry("atlas", n));
    now += ONCE_LIMITS.ttlMs - 1;
    expect(store.forSession("s1")).toHaveLength(3);
    now += 1;
    expect(store.forSession("s1")).toEqual([]);
    expect(store.size()).toBe(0);
    expect(ONCE_LIMITS.ttlMs).toBe(24 * HOUR);
    expect(store.put(refOf(salt, "F_SIX"), entry("atlas", "F_SIX"))).toBe("ok");
  });

  it("dropAgent forgets every value of that agent and counts them", () => {
    const store = createOnceStore(() => 0);
    store.put(refOf(salt, "a"), entry("atlas", "A_ONE"));
    store.put(refOf(salt, "b"), entry("atlas", "B_TWO"));
    store.put(refOf(salt, "c"), entry("bolt", "C_THREE", "s2"));
    expect(store.dropAgent("atlas")).toBe(2);
    expect(store.forSession("s1")).toEqual([]);
    expect(store.size()).toBe(1);
    expect(store.dropAgent("atlas")).toBe(0);
  });
});
