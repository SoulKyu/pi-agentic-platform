import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createOutbox } from "../../../kernel/outbox/index.ts";
import { OWNER, openSendBed, target, type SendBed } from "../testing/send-bed.ts";
import { registerPushEffects } from "./index.ts";

let t: SendBed;
afterEach(() => t.close());
const ref = { ownerId: OWNER, refKind: "session", refId: "s1" } as const;
const outboxNextAt = () => t.bed.db.get<{ next_at: number }>("SELECT next_at FROM outbox")?.next_at;

describe("send.retry-then-ok", () => {
  it("retries after the outbox backoff (5 s) and then sends", async () => {
    t = openSendBed();
    t.transport.next({ kind: "retry" });
    const id = t.notifier.notify({ ...ref, cls: "failed" })?.id ?? "";
    await t.step();
    expect(t.transport.sent).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({ id, state: "pending" });
    expect(t.deliveries()).toEqual([{ sub_id: "a", state: "pending", attempts: 1, reason: null }]);
    await t.step(4_999);
    expect(t.transport.sent).toHaveLength(1);
    await t.step(1);
    expect(t.transport.sent).toHaveLength(2);
    expect(t.events()[0]).toMatchObject({ state: "sent" });
    expect(t.transport.sent.map((c) => c.opts.topic)).toEqual([id, id]);
  });

  it("a deferral consumes no attempt of the outbox", async () => {
    t = openSendBed();
    t.transport.next({ kind: "retry" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.bed.db.get("SELECT status, attempts FROM outbox")).toEqual({ status: "pending", attempts: 0 });
  });

  it("waits for Retry-After when it is longer than the backoff", async () => {
    t = openSendBed();
    t.transport.next({ kind: "retry", afterMs: 30_000 });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(outboxNextAt()).toBe(t.bed.clock.now() + 30_000);
    await t.step(29_999);
    expect(t.transport.sent).toHaveLength(1);
    await t.step(1);
    expect(t.transport.sent).toHaveLength(2);
  });

  it("uses the backoff when Retry-After is shorter, and clamps a huge Retry-After to an hour", async () => {
    t = openSendBed();
    t.transport.next({ kind: "retry", afterMs: 1_000 });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(outboxNextAt()).toBe(t.bed.clock.now() + 5_000);
    t.transport.next({ kind: "retry", afterMs: 86_400_000 });
    await t.step(5_000);
    expect(outboxNextAt()).toBe(t.bed.clock.now() + 3_600_000);
  });

  it("doubles the backoff on each attempt", async () => {
    t = openSendBed();
    for (let i = 0; i < 4; i++) t.transport.next({ kind: "retry" });
    t.notifier.notify({ ...ref, cls: "failed" });
    const waits: number[] = [];
    await t.step();
    for (let i = 0; i < 4; i++) {
      waits.push((outboxNextAt() ?? 0) - t.bed.clock.now());
      await t.step(waits[i]);
    }
    expect(waits).toEqual([5_000, 10_000, 20_000, 40_000]);
  });
});

describe("send.retry-exhausted", () => {
  it("fails the delivery after five retries, keeps a reason class and logs a hash, not the endpoint", async () => {
    t = openSendBed();
    for (let i = 0; i < 5; i++) t.transport.next({ kind: "retry" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    for (let i = 0; i < 4; i++) await t.step(40_000);
    expect(t.transport.sent).toHaveLength(5);
    expect(t.deliveries()).toEqual([
      { sub_id: "a", state: "failed", attempts: 5, reason: "retry_exhausted" },
    ]);
    expect(t.events()[0]).toMatchObject({ state: "failed", reason: "retry_exhausted" });
    expect(
      JSON.parse(
        t.bed.db.get<{ value: string }>("SELECT value FROM push_meta WHERE key = 'last_failure:u1'")?.value ??
          "{}",
      ),
    ).toEqual({
      at: t.bed.clock.now(),
      reason: "retry_exhausted",
    });
    expect(t.bed.db.get("SELECT status FROM outbox")).toEqual({ status: "done" });
    expect(t.outbox.failures(OWNER)).toEqual([]);
    const logged = JSON.stringify(t.bed.logs);
    const hash = createHash("sha256").update(target("a").endpoint).digest("hex").slice(0, 12);
    expect(logged).toContain(`h:${hash}`);
    expect(logged).not.toContain("secret-path");
    expect(logged).not.toContain("push.example.net");
  });

  it("a rejected target is final at once, a 429 is not", async () => {
    t = openSendBed(["a", "b"]);
    t.transport.next({ kind: "rejected", status: 403 });
    t.transport.next({ kind: "retry" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.deliveries()).toEqual([
      { sub_id: "a", state: "failed", attempts: 0, reason: "rejected" },
      { sub_id: "b", state: "pending", attempts: 1, reason: null },
    ]);
    expect(t.events()[0]).toMatchObject({ state: "pending" });
  });
});

describe("send.crash-resumes-pending-only", () => {
  it("after a crash between the bookkeeping and the settle, only the unsent target is sent again", async () => {
    t = openSendBed(["a", "b"]);
    t.transport.next({ kind: "ok" });
    t.transport.next({ kind: "retry" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent.map((c) => c.target.id)).toEqual(["a", "b"]);
    // The daemon died with the row leased.
    t.bed.db.run("UPDATE outbox SET status = 'leased', lease_until = 0");
    const reborn = createOutbox({ db: t.bed.db, clock: t.bed.clock, logger: t.bed.logger, readOnly: false });
    registerPushEffects(
      reborn,
      {
        db: t.bed.db,
        clock: t.bed.clock,
        logger: t.bed.logger,
        transport: t.transport,
        subscriptions: t.subs,
        sessionLive: t.subs,
        presence: t.presence,
        cooldown: t.cooldown,
        notifications: () => t.state.settings,
        quiet: () => false,
        onHold: () => {},
        stillWaiting: () => true,
      },
      { notifier: t.notifier, judge: () => "waiting" },
    );
    expect(reborn.recover()).toMatchObject({ requeued: 1 });
    await t.bed.clock.advance(5_000);
    await reborn.drain();
    expect(t.transport.sent.map((c) => c.target.id)).toEqual(["a", "b", "b"]);
    expect(t.events()[0]).toMatchObject({ state: "sent" });

    // The event is sent: a replay of its effect sends nothing.
    t.bed.db.run("UPDATE outbox SET status = 'pending', settled_at = NULL");
    await reborn.drain();
    expect(t.transport.sent).toHaveLength(3);
  });
});
