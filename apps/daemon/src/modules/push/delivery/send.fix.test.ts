import { afterEach, describe, expect, it } from "vitest";
import type { SendOutcome } from "../index.ts";
import { OWNER, openSendBed, target, type SendBed } from "../testing/send-bed.ts";

let t: SendBed;
afterEach(() => t.close());
const ref = { ownerId: OWNER, refKind: "session", refId: "s1" } as const;
const lastFailure = (owner: string) =>
  t.bed.db.get<{ value: string }>("SELECT value FROM push_meta WHERE key = $key", {
    key: `last_failure:${owner}`,
  })?.value;
const outboxNextAt = () => t.bed.db.get<{ next_at: number }>("SELECT next_at FROM outbox")?.next_at;

describe("an outcome outside the port's type", () => {
  it.each([
    ["an unknown kind", { kind: "bogus" }],
    ["a string", "ok"],
  ])("%s is refused once, never re-sent", async (_name, outcome) => {
    t = openSendBed();
    t.transport.next(outcome as unknown as SendOutcome);
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    await t.step(60_000);
    expect(t.transport.sent).toHaveLength(1);
    expect(t.deliveries()).toEqual([{ sub_id: "a", state: "failed", attempts: 0, reason: "refused" }]);
    expect(t.events()[0]).toMatchObject({ state: "failed", reason: "refused" });
    expect(t.bed.db.get("SELECT status FROM outbox")).toEqual({ status: "done" });
    expect(JSON.stringify(t.bed.logs)).toContain('"why":"other"');
  });
});

describe("a null outcome", () => {
  it("is refused like any other unknown answer", async () => {
    t = openSendBed();
    t.transport.send = async () => null as unknown as SendOutcome;
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.deliveries()).toEqual([{ sub_id: "a", state: "failed", attempts: 0, reason: "refused" }]);
  });
});

describe("last failure is per owner (W6-R6)", () => {
  it("owner B's failure never changes owner A's value", async () => {
    t = openSendBed();
    t.subs.add("u2", { ...target("z"), credentialId: "c-z" });
    t.transport.next({ kind: "rejected", status: 400 });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    const first = lastFailure(OWNER);
    expect(JSON.parse(first ?? "{}")).toMatchObject({ reason: "rejected" });
    await t.bed.clock.advance(10_000);
    t.transport.next({ kind: "refused", reason: "blocked" });
    t.notifier.notify({ ownerId: "u2", cls: "failed", refKind: "session", refId: "s9" });
    await t.step();
    expect(lastFailure(OWNER)).toBe(first);
    expect(JSON.parse(lastFailure("u2") ?? "{}")).toMatchObject({ reason: "refused" });
  });

  it("an owner with no device gets no write", async () => {
    t = openSendBed();
    t.notifier.notify({ ownerId: "u3", cls: "failed", refKind: "session", refId: "s1" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "no_target" });
    expect(t.bed.db.all("SELECT key FROM push_meta")).toEqual([]);
  });

  it("devices that all died do write no_target", async () => {
    t = openSendBed();
    t.subs.setSessionLive(false);
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(JSON.parse(lastFailure(OWNER) ?? "{}")).toMatchObject({ reason: "no_target" });
  });
});

describe("one throwing delivery", () => {
  it("waits for the other sends, keeps their result, and the effect retries", async () => {
    t = openSendBed(["a", "b"]);
    const hold = t.transport.hold();
    t.subs.markOk = (id) => {
      if (id === "b") throw new Error("boom");
    };
    t.notifier.notify({ ...ref, cls: "failed" });
    let ended = false;
    const pass = t.step().then(() => void (ended = true));
    await t.bed.clock.advance(0);
    expect(t.transport.sent).toHaveLength(2);
    expect(ended).toBe(false); // b already threw; a is still in flight and is waited for
    hold.release();
    await pass;
    expect(t.deliveries()).toEqual([
      { sub_id: "a", state: "done", attempts: 0, reason: null },
      { sub_id: "b", state: "pending", attempts: 0, reason: null },
    ]);
    expect(t.bed.db.get("SELECT status, attempts FROM outbox")).toEqual({ status: "pending", attempts: 1 });
    expect(t.bed.logs.map((l) => l.msg)).toContain("push_send_error");
  });
});

describe("a bad Retry-After", () => {
  it.each([
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -5],
    ["a string", "30" as unknown as number],
  ])("%s falls back to the backoff", async (_name, afterMs) => {
    t = openSendBed();
    t.transport.next({ kind: "retry", afterMs });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(outboxNextAt()).toBe(t.bed.clock.now() + 5_000);
  });

  it("rounds a fraction up to a whole millisecond", async () => {
    t = openSendBed();
    t.transport.next({ kind: "retry", afterMs: 6_000.2 });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(outboxNextAt()).toBe(t.bed.clock.now() + 6_001);
  });
});
