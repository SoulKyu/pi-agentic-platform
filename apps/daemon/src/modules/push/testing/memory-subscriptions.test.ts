import { describe, expect, it } from "vitest";
import type { SubscriptionTarget } from "../index.ts";
import { createMemorySubscriptions } from "./memory-subscriptions.ts";

const target = (id: string, credentialId: string): SubscriptionTarget => ({
  id,
  endpoint: `https://push.example.net/${id}`,
  p256dh: "p",
  auth: "a",
  credentialId,
  locale: "fr",
});

describe("createMemorySubscriptions", () => {
  it("returns an owner's targets, or only one credential's", () => {
    const subs = createMemorySubscriptions();
    subs.add("u1", target("a", "c1"));
    subs.add("u1", target("b", "c2"));
    subs.add("u2", target("c", "c1"));
    expect(subs.targets("u1").map((row) => row.id)).toEqual(["a", "b"]);
    expect(subs.targets("u1", "c2").map((row) => row.id)).toEqual(["b"]);
    expect(subs.targets("u3")).toEqual([]);
    expect(subs.targets("u2", "c2")).toEqual([]);
  });

  it("refuses nothing: more than ten rows are kept", () => {
    const subs = createMemorySubscriptions();
    for (let i = 0; i < 25; i += 1) subs.add("u1", target(`s${i}`, "c1"));
    expect(subs.targets("u1")).toHaveLength(25);
  });

  it("drop removes the row and records why; markOk records the time", () => {
    const subs = createMemorySubscriptions();
    subs.add("u1", target("a", "c1"));
    subs.markOk("a", 42);
    subs.drop("a", "gone");
    expect(subs.targets("u1")).toEqual([]);
    expect(subs.dropped).toEqual([{ id: "a", why: "gone" }]);
    expect(subs.okAt.get("a")).toBe(42);
  });

  it("sessionLive is true until a test switches it, for everyone or by a rule", () => {
    const subs = createMemorySubscriptions();
    expect(subs.sessionLive("u1", "c1")).toBe(true);
    subs.setSessionLive((_owner, credentialId) => credentialId !== "dead");
    expect(subs.sessionLive("u1", "c1")).toBe(true);
    expect(subs.sessionLive("u1", "dead")).toBe(false);
    subs.setSessionLive(false);
    expect(subs.sessionLive("u1", "c1")).toBe(false);
  });
});
