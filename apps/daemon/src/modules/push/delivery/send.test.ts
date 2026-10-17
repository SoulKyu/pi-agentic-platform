import { PushWire } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER, openSendBed, target, type SendBed } from "../testing/send-bed.ts";

let t: SendBed;
afterEach(() => t.close());
const ref = { ownerId: OWNER, refKind: "session", refId: "s1" } as const;
const sentAt = (id: string) =>
  t.bed.db.get<{ sent_at: number | null }>("SELECT sent_at FROM outbox WHERE dedup_key = $key", {
    key: `push.send:${id}`,
  })?.sent_at;
const wire = (call: number) =>
  PushWire.parse(JSON.parse(new TextDecoder().decode(t.transport.sent[call]?.plaintext)));

describe("send.fans-out", () => {
  it("sends one call per subscription with the event id as topic, urgency and ttl, and never marks sent", async () => {
    t = openSendBed(["a", "b"]);
    const id = t.notifier.notify({ ...ref, cls: "approval" })?.id ?? "";
    await t.step(60_000);
    expect(t.transport.sent.map((c) => [c.target.id, c.opts])).toEqual([
      ["a", { ttlSeconds: 3600, urgency: "high", topic: id }],
      ["b", { ttlSeconds: 3600, urgency: "high", topic: id }],
    ]);
    expect(t.events()[0]).toMatchObject({ id, state: "sent" });
    expect(t.subs.okAt.size).toBe(2);
    expect(sentAt(id)).toBeNull();
  });

  it.each([
    ["approval", "high", 3600],
    ["failed", "high", 14_400],
    ["budget", "high", 14_400],
    ["notify", "normal", 14_400],
    ["done", "normal", 3600],
    ["reply", "normal", 3600],
    ["review", "normal", 3600],
  ] as const)("%s is %s with a %i s ttl", async (cls, urgency, ttlSeconds) => {
    t = openSendBed();
    t.state.settings = { ...t.state.settings, classes: { ...t.state.settings.classes, [cls]: true } };
    t.notifier.notify({ ...ref, cls });
    await t.step(60_000);
    expect(t.transport.sent.map((c) => c.opts)).toMatchObject([{ ttlSeconds, urgency }]);
  });
});

describe("send.skips-dead-session", () => {
  it("drops the row and sends nothing when the session is not live", async () => {
    t = openSendBed();
    t.subs.setSessionLive(false);
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(t.subs.dropped).toEqual([{ id: "a", why: "dead_session" }]);
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "no_target" });
    expect(t.bed.db.get("SELECT value FROM push_meta WHERE key = 'last_failure:u1'")).toMatchObject({
      value: expect.stringContaining("no_target"),
    });
  });

  it("asks again before each send: a session that died since the first pass is not sent to", async () => {
    t = openSendBed();
    t.transport.next({ kind: "retry" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent).toHaveLength(1);
    t.subs.setSessionLive(false);
    await t.step(5_000);
    expect(t.transport.sent).toHaveLength(1);
    expect(t.subs.dropped).toEqual([{ id: "a", why: "dead_session" }]);
    expect(t.deliveries()).toEqual([{ sub_id: "a", state: "gone", attempts: 1, reason: "dead_session" }]);
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "no_target" });
  });

  it("keeps the live devices of the same owner", async () => {
    t = openSendBed(["a", "b"]);
    t.subs.setSessionLive((_owner, credential) => credential === "c-b");
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent.map((c) => c.target.id)).toEqual(["b"]);
    expect(t.events()[0]).toMatchObject({ state: "sent" });
  });
});

describe("send.gone-drops-row", () => {
  it("drops a gone subscription and the others continue", async () => {
    t = openSendBed(["a", "b"]);
    t.transport.next({ kind: "gone" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.subs.dropped).toEqual([{ id: "a", why: "gone" }]);
    expect(t.transport.sent.map((c) => c.target.id)).toEqual(["a", "b"]);
    expect(t.events()[0]).toMatchObject({ state: "sent" });
    expect(t.deliveries()).toEqual([
      { sub_id: "a", state: "gone", attempts: 0, reason: "gone" },
      { sub_id: "b", state: "done", attempts: 0, reason: null },
    ]);
  });

  it("a gone only target is not a failure: nothing to retry, nobody to tell", async () => {
    t = openSendBed();
    t.transport.next({ kind: "gone" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "no_target" });
  });
});

describe("send.partial", () => {
  it("is sent when one target succeeded and the other was rejected", async () => {
    t = openSendBed(["a", "b"]);
    t.transport.next({ kind: "ok" });
    t.transport.next({ kind: "rejected", status: 403 });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "sent" });
    expect(t.deliveries()).toEqual([
      { sub_id: "a", state: "done", attempts: 0, reason: null },
      { sub_id: "b", state: "failed", attempts: 0, reason: "rejected" },
    ]);
  });

  it("is failed with the reason class when every target failed, and the effect settles done", async () => {
    t = openSendBed(["a", "b"]);
    t.transport.next({ kind: "rejected", status: 400 });
    t.transport.next({ kind: "refused", reason: "blocked_address" });
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "failed", reason: "rejected" });
    expect(
      JSON.parse(
        t.bed.db.get<{ value: string }>("SELECT value FROM push_meta WHERE key = 'last_failure:u1'")?.value ??
          "{}",
      ),
    ).toEqual({
      at: t.bed.clock.now(),
      reason: "rejected",
    });
    expect(t.outbox.failures(OWNER)).toEqual([]);
    expect(t.bed.db.get("SELECT status FROM outbox")).toEqual({ status: "done" });
  });

  it("one slow target does not block the others", async () => {
    t = openSendBed(["a", "b"]);
    const hold = t.transport.hold();
    t.notifier.notify({ ...ref, cls: "failed" });
    const pass = t.step();
    await t.bed.clock.advance(0);
    expect(t.transport.sent.map((c) => c.target.id)).toEqual(["a", "b"]);
    hold.release();
    await pass;
    expect(t.events()[0]).toMatchObject({ state: "sent" });
  });
});

describe("approval.answered-in-window", () => {
  it("sends nothing when the approval was answered at +59 s and the source says so at +60 s", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "approval" });
    await t.step(59_000);
    t.state.waiting = false;
    await t.step(1_000);
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "gone" });
  });

  it("the cancel by key retires the row and sends nothing", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "approval" });
    await t.step(59_000);
    t.notifier.cancel(t.notifier.keyOf("approval", "session", "s1"), "answered");
    await t.step(1_000);
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "answered" });
    expect(t.bed.db.get("SELECT status FROM outbox")).toEqual({ status: "retired" });
  });

  it("a cancel that came while the effect was leased is honoured before the first send", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "failed" });
    t.bed.db.run("UPDATE outbox SET cancel_requested = 1");
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "cancelled", reason: "cancelled" });
  });

  it("a settled event is not sent again when its effect is replayed", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    t.bed.db.run("UPDATE outbox SET status = 'pending', settled_at = NULL");
    await t.step();
    expect(t.transport.sent).toHaveLength(1);
  });
});

describe("focused.recheck", () => {
  it("defers an approval while a tab looks, then sends once the entry is stale", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "approval" });
    await t.bed.clock.advance(60_000);
    t.presence.report(OWNER, "tab", true);
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "pending", rechecks: 1 });
    await t.step(60_000); // the entry is 60 s old: stale (45 s)
    expect(t.transport.sent).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({ state: "sent", rechecks: 1 });
  });

  it("settles suppressed:focused after three re-checks with a tab still looking", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "approval" });
    await t.bed.clock.advance(60_000);
    for (let i = 1; i <= 3; i++) {
      t.presence.report(OWNER, "tab", true);
      await t.step();
      expect(t.events()[0]).toMatchObject({ state: "pending", rechecks: i });
      await t.bed.clock.advance(60_000);
    }
    t.presence.report(OWNER, "tab", true);
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "suppressed", reason: "focused", rechecks: 3 });
    expect(t.transport.sent).toEqual([]);
  });

  it("a non-approval event is suppressed at once while a tab looks", async () => {
    t = openSendBed();
    t.presence.report(OWNER, "tab", true);
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "suppressed", reason: "focused" });
  });
});

describe("suppression rules", () => {
  it("muted-suppresses", async () => {
    t = openSendBed();
    t.state.settings = { ...t.state.settings, muteUntil: t.bed.clock.now() + 1000 };
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "suppressed", reason: "muted" });
  });

  it("class-off-suppresses", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "done" });
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "suppressed", reason: "class_off" });
  });

  it("cooldown-suppresses a second push for the same ref within 5 s", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent).toHaveLength(1);
    expect(t.events().map((e) => [e.state, e.reason])).toEqual([
      ["sent", null],
      ["suppressed", "cooldown"],
    ]);
  });

  it("a rate_cap or a hold never consumes the cooldown window", async () => {
    t = openSendBed();
    t.state.quiet = true;
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "held" });
    expect(t.state.holds).toBe(1);
    expect(t.cooldown.free(t.notifier.keyOf("failed", "session", "s1"))).toBe(true);

    t.state.quiet = false;
    for (let i = 0; i < 20; i++)
      t.bed.db.run(
        "INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at, settled_at) VALUES ($id, 'u1', 'failed', 'x', $id, $id, 'sent', $now, $now)",
        { id: `old${i}`, now: t.bed.clock.now() },
      );
    t.notifier.notify({ ...ref, refId: "s2", cls: "failed" });
    await t.step();
    expect(t.events().at(-1)).toMatchObject({ state: "suppressed", reason: "rate_cap" });
    expect(t.cooldown.free(t.notifier.keyOf("failed", "session", "s2"))).toBe(true);
  });

  it("rate-cap.exempts-approval: the 21st failed push is capped, an approval still goes", async () => {
    t = openSendBed();
    for (let i = 0; i < 21; i++) t.notifier.notify({ ...ref, refId: `f${i}`, cls: "failed" });
    t.notifier.notify({ ...ref, refId: "q", cls: "approval" });
    await t.step(60_000);
    const states = t.events().map((e) => `${e.cls}:${e.state}:${e.reason ?? ""}`);
    expect(states.filter((s) => s === "failed:sent:")).toHaveLength(20);
    expect(states).toContain("failed:suppressed:rate_cap");
    expect(states).toContain("approval:sent:");
  });

  it("holds an event in quiet hours and sends nothing", async () => {
    t = openSendBed();
    t.state.quiet = true;
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(t.events()[0]).toMatchObject({ state: "held" });
  });

  it("a test push skips the rules", async () => {
    t = openSendBed();
    t.state.settings = { ...t.state.settings, muteUntil: t.bed.clock.now() + 1000 };
    t.notifier.notify({ ownerId: OWNER, refKind: "test", refId: "x", cls: "test" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "sent" });
  });
});

describe("payload.is-generic", () => {
  it("is a PushWire with the generic body in the target's locale", async () => {
    t = openSendBed(["a"]);
    t.subs.add(OWNER, target("b", "fr"));
    const id = t.notifier.notify({ ...ref, cls: "failed", name: "Nightly build" })?.id ?? "";
    await t.step();
    expect(wire(0)).toEqual({
      v: 1,
      id,
      cls: "failed",
      title: "pap",
      body: "A task did not finish.",
      ts: t.bed.clock.now(),
    });
    expect(wire(1).body).toBe("Une tâche ne s'est pas terminée.");
  });

  it("appends the registry name only with titles: names", async () => {
    t = openSendBed();
    t.state.settings = { ...t.state.settings, titles: "names" };
    t.notifier.notify({ ...ref, cls: "failed", name: "Nightly build" });
    await t.step();
    expect(wire(0).body).toBe("A task did not finish. - Nightly build");
  });

  it("an event with no name stays generic in names mode", async () => {
    t = openSendBed();
    t.state.settings = { ...t.state.settings, titles: "names" };
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(wire(0).body).toBe("A task did not finish.");
  });

  it("carries nothing but the PushWire keys", async () => {
    t = openSendBed();
    t.notifier.notify({ ...ref, cls: "failed", name: "Nightly build" });
    await t.step();
    expect(Object.keys(JSON.parse(new TextDecoder().decode(t.transport.sent[0]?.plaintext))).sort()).toEqual([
      "body",
      "cls",
      "id",
      "title",
      "ts",
      "v",
    ]);
  });
});

describe("a handler never throws", () => {
  it("a transport that throws is a retry, and the log carries the error class only", async () => {
    t = openSendBed();
    t.transport.send = async () => {
      throw new TypeError("https://push.example.net/secret-path-a is not a URL");
    };
    t.notifier.notify({ ...ref, cls: "failed" });
    await t.step();
    expect(t.deliveries()).toEqual([{ sub_id: "a", state: "pending", attempts: 1, reason: null }]);
    expect(JSON.stringify(t.bed.logs)).not.toContain("secret-path");
    expect(t.bed.logs.map((l) => l.msg)).not.toContain("outbox_handler_error");
  });
});
