import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const compared = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls += 1;
      return actual.timingSafeEqual(a, b);
    },
  };
});

const { createRelayKeys, presentedKey } = await import("./keys.ts");

/*
 * Mutants (RT-43), each run for real:
 *  - M-address: drop `grant.address === address` in `boxOf` -> "from another VM's address" fails.
 *  - M-constant-time: replace `timingSafeEqual` by `===` -> "compares in constant time" fails (the spy sees no call).
 *  - M-revoke: `remove` leaves the digest -> "after remove" fails.
 */
const grant = (over: Partial<Parameters<ReturnType<typeof createRelayKeys>["add"]>[0]> = {}) => ({
  launchId: "a".repeat(32),
  box: { kind: "agent", id: "agent-one" } as const,
  key: randomBytes(32),
  address: "10.213.0.2",
  ...over,
});

describe("createRelayKeys", () => {
  it("gives the agent of a launch's key from its own address", () => {
    const keys = createRelayKeys();
    const one = grant();
    keys.add(one);
    expect(keys.boxOf(one.key.toString("hex"), "10.213.0.2")).toEqual({ kind: "agent", id: "agent-one" });
  });

  it("compares in constant time (M-constant-time)", () => {
    const keys = createRelayKeys();
    const one = grant();
    keys.add(one);
    const before = compared.calls;
    expect(keys.boxOf(one.key.toString("hex"), "10.213.0.2")).toEqual({ kind: "agent", id: "agent-one" });
    expect(compared.calls).toBe(before + 1);
  });

  it("refuses the key from another VM's address (M-address)", () => {
    const keys = createRelayKeys();
    const one = grant();
    keys.add(one);
    expect(keys.boxOf(one.key.toString("hex"), "10.213.0.3")).toBeNull();
    expect(keys.boxOf(one.key.toString("hex"), "127.0.0.1")).toBeNull();
    expect(keys.boxOf(one.key.toString("hex"), undefined)).toBeNull();
  });

  it("keeps two launches apart", () => {
    const keys = createRelayKeys();
    const one = grant();
    const two = grant({
      launchId: "b".repeat(32),
      box: { kind: "agent", id: "agent-two" } as const,
      address: "10.213.0.3",
    });
    keys.add(one);
    keys.add(two);
    expect(keys.boxOf(two.key.toString("hex"), "10.213.0.3")).toEqual({ kind: "agent", id: "agent-two" });
    expect(keys.boxOf(two.key.toString("hex"), "10.213.0.2")).toBeNull();
    expect(keys.boxOf(one.key.toString("hex"), "10.213.0.3")).toBeNull();
  });

  it("refuses a revoked key (M-revoke)", () => {
    const keys = createRelayKeys();
    const one = grant();
    keys.add(one);
    keys.remove(one.launchId);
    expect(keys.boxOf(one.key.toString("hex"), "10.213.0.2")).toBeNull();
    keys.remove(one.launchId);
  });

  it("refuses a changed character, upper case, the placeholder and garbage", () => {
    const keys = createRelayKeys();
    const one = grant({ key: Buffer.alloc(32, 0xab) });
    keys.add(one);
    const hex = one.key.toString("hex");
    expect(keys.boxOf(`${hex.slice(0, 63)}c`, "10.213.0.2")).toBeNull();
    expect(keys.boxOf(hex.toUpperCase(), "10.213.0.2")).toBeNull();
    expect(keys.boxOf("placeholder", "10.213.0.2")).toBeNull();
    expect(keys.boxOf("", "10.213.0.2")).toBeNull();
    expect(keys.boxOf(null, "10.213.0.2")).toBeNull();
    expect(keys.boxOf(`${hex}00`, "10.213.0.2")).toBeNull();
  });

  it("refuses a key that is not 32 bytes at add", () => {
    const keys = createRelayKeys();
    expect(() => keys.add(grant({ key: randomBytes(16) }))).toThrow(RangeError);
    expect(() => keys.add(grant({ key: randomBytes(33) }))).toThrow(RangeError);
  });

  it("re-adding a launch drops its previous key", () => {
    const keys = createRelayKeys();
    const first = grant();
    const second = grant();
    keys.add(first);
    keys.add(second);
    expect(keys.boxOf(first.key.toString("hex"), "10.213.0.2")).toBeNull();
    expect(keys.boxOf(second.key.toString("hex"), "10.213.0.2")).toEqual({ kind: "agent", id: "agent-one" });
  });
});

describe("presentedKey", () => {
  const k = "ab".repeat(32);
  const other = "cd".repeat(32);
  it("takes x-api-key, x-goog-api-key or authorization: Bearer", () => {
    expect(presentedKey({ "x-api-key": k })).toBe(k);
    expect(presentedKey({ "x-goog-api-key": k })).toBe(k);
    expect(presentedKey({ authorization: `Bearer ${k}` })).toBe(k);
  });
  it("accepts the same key in two headers", () => {
    expect(presentedKey({ "x-api-key": k, authorization: `Bearer ${k}` })).toBe(k);
  });
  it("refuses two different keys, a joined duplicate, Basic, a double space, none", () => {
    expect(presentedKey({ "x-api-key": k, authorization: `Bearer ${other}` })).toBeNull();
    expect(presentedKey({ "x-api-key": `${k}, ${k}` })).toBeNull();
    expect(presentedKey({ "x-api-key": [k, k] })).toBeNull();
    expect(presentedKey({ authorization: [`Bearer ${k}`] })).toBeNull();
    expect(presentedKey({ authorization: `Basic ${k}` })).toBeNull();
    expect(presentedKey({ authorization: `Bearer  ${k}` })).toBeNull();
    expect(presentedKey({ authorization: `bearer ${k}` })).toBeNull();
    expect(presentedKey({})).toBeNull();
    expect(presentedKey({ "x-api-key": "placeholder" })).toBeNull();
    expect(presentedKey({ "x-api-key": k.toUpperCase() })).toBeNull();
  });
});

describe("createRelayKeys: revoke listeners and the launch of a request (T12)", () => {
  it("tells the launch of a key, and the listeners only of a remove", () => {
    const keys = createRelayKeys();
    const told: string[] = [];
    keys.onRemove((launchId) => void told.push(launchId));
    const one = grant();
    keys.add(one);
    expect(keys.grantOf(one.key.toString("hex"), "10.213.0.2")).toEqual({
      launchId: one.launchId,
      box: { kind: "agent", id: "agent-one" } as const,
    });
    keys.add({ ...one, key: randomBytes(32) });
    expect(told).toEqual([]);
    keys.remove(one.launchId);
    expect(told).toEqual([one.launchId]);
  });
});
