import { PushWire } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { OWNER, openSendBed, target, type SendBed } from "../testing/send-bed.ts";

let t: SendBed;
afterEach(() => t.close());

/** The fake clock starts at 23:13 in Paris: inside 22:00-07:00. The window ends at 06:00Z the next day. */
const TO_MORNING_MS = 28_000_000;
const MORNING = 1_700_000_000_000 + TO_MORNING_MS;
const ref = (id: string) => ({ ownerId: OWNER, refKind: "session", refId: id }) as const;

/** A French device in the quiet window, with `state.quiet` asking the real hours. */
function night(): SendBed {
  const bed = openSendBed([]);
  bed.subs.add(OWNER, target("a", "fr"));
  bed.state.quiet = "window";
  return bed;
}
const wire = (call: number) =>
  PushWire.parse(JSON.parse(new TextDecoder().decode(t.transport.sent[call]?.plaintext)));
const digestRows = () =>
  t.bed.db.all<{ next_at: number; dedup_key: string; status: string }>(
    "SELECT next_at, dedup_key, status FROM outbox WHERE kind = 'digest.send'",
  );
const states = () => t.events().map((e) => `${e.cls}:${e.state}:${e.reason ?? ""}`);

describe("quiet.holds-then-digest", () => {
  it("holds three events, queues ONE digest at 07:00 and sends one French line then", async () => {
    t = night();
    for (const id of ["s1", "s2", "s3"]) t.notifier.notify({ ...ref(id), cls: "failed" });
    await t.step();
    expect(states()).toEqual(["failed:held:", "failed:held:", "failed:held:"]);
    expect(t.transport.sent).toEqual([]);
    expect(digestRows()).toEqual([
      { next_at: MORNING, dedup_key: `digest:${OWNER}:${MORNING / 60_000}`, status: "pending" },
    ]);

    await t.step(TO_MORNING_MS - 1);
    expect(t.transport.sent).toEqual([]);
    await t.step(1);
    expect(t.transport.sent).toHaveLength(1);
    expect(t.transport.sent[0]?.opts.topic).toBe(t.events().at(-1)?.id);
    expect(wire(0)).toMatchObject({ cls: "digest", title: "pap", body: "3 éléments vous attendent." });
    expect(states()).toEqual([
      "failed:digested:" + (t.events().at(-1)?.id ?? ""),
      "failed:digested:" + (t.events().at(-1)?.id ?? ""),
      "failed:digested:" + (t.events().at(-1)?.id ?? ""),
      "digest:sent:",
    ]);
  });

  it("an event that arrives later in the night joins the same digest", async () => {
    t = night();
    t.notifier.notify({ ...ref("s1"), cls: "failed" });
    await t.step(3_600_000);
    t.notifier.notify({ ...ref("s2"), cls: "failed" });
    await t.step();
    expect(digestRows()).toHaveLength(1);
    await t.step(TO_MORNING_MS);
    expect(wire(0).body).toBe("2 éléments vous attendent.");
  });

  it("a replay of a held event's effect re-ensures the digest and queues no second one", async () => {
    t = night();
    t.notifier.notify({ ...ref("s1"), cls: "failed" });
    await t.step();
    t.bed.db.run("UPDATE outbox SET status = 'pending', settled_at = NULL WHERE kind = 'push.send'");
    await t.step();
    expect(digestRows()).toHaveLength(1);
    t.bed.db.run("DELETE FROM outbox WHERE kind = 'digest.send'");
    t.bed.db.run("UPDATE outbox SET status = 'pending', settled_at = NULL WHERE kind = 'push.send'");
    await t.step();
    expect(digestRows()).toHaveLength(1);
    expect(t.events()[0]).toMatchObject({ state: "held" });
  });

  it("settling the held event and queueing the digest are ONE transaction", async () => {
    t = night();
    t.bed.db.exec(
      `CREATE TRIGGER no_digest BEFORE INSERT ON outbox WHEN NEW.kind = 'digest.send'
       BEGIN SELECT RAISE(ABORT, 'no room'); END`,
    );
    t.notifier.notify({ ...ref("s1"), cls: "failed" });
    await t.step();
    expect(t.events()[0]).toMatchObject({ state: "pending" });
    t.bed.db.exec("DROP TRIGGER no_digest");
    await t.step(5_000);
    expect(t.events()[0]).toMatchObject({ state: "held" });
    expect(digestRows()).toHaveLength(1);
  });
});

describe("digest.skips-resolved", () => {
  it("counts only the items that still wait", async () => {
    t = night();
    for (const id of ["s1", "s2", "s3"]) t.notifier.notify({ ...ref(id), cls: "failed" });
    await t.step();
    t.state.judge = (event) => (event.refId === "s2" ? "gone" : "waiting");
    await t.step(TO_MORNING_MS);
    expect(wire(0).body).toBe("2 éléments vous attendent.");
    expect(states().filter((s) => s.startsWith("failed:cancelled"))).toEqual(["failed:cancelled:gone"]);
    expect(states().filter((s) => s.startsWith("failed:digested"))).toHaveLength(2);
  });

  it("sends nothing when every item was resolved", async () => {
    t = night();
    for (const id of ["s1", "s2", "s3"]) t.notifier.notify({ ...ref(id), cls: "failed" });
    await t.step();
    t.state.judge = () => "gone";
    await t.step(TO_MORNING_MS);
    expect(t.transport.sent).toEqual([]);
    expect(states()).toEqual(["failed:cancelled:gone", "failed:cancelled:gone", "failed:cancelled:gone"]);
  });

  it("a single item reads in the singular", async () => {
    t = night();
    t.notifier.notify({ ...ref("s1"), cls: "failed" });
    await t.step();
    await t.step(TO_MORNING_MS);
    expect(wire(0).body).toBe("1 élément vous attend.");
  });
});

describe("digest.counts-expired", () => {
  it("says how many requests expired, even with nothing else waiting", async () => {
    t = night();
    t.notifier.notify({ ...ref("agent-approve"), refKind: "inbox", cls: "approval" });
    t.notifier.notify({ ...ref("task-question"), cls: "approval" });
    t.notifier.notify({ ...ref("answered"), cls: "approval" });
    await t.step(60_000);
    expect(states()).toEqual(["approval:held:", "approval:held:", "approval:held:"]);
    t.state.judge = (event) => (event.refId === "answered" ? "gone" : "expired");
    await t.step(TO_MORNING_MS);
    expect(wire(0).body).toBe("2 demandes ont expiré pendant les heures calmes.");
    expect(states()).toEqual([
      "approval:cancelled:expired",
      "approval:cancelled:expired",
      "approval:cancelled:gone",
      "digest:sent:",
    ]);
  });

  it("puts the two lines together", async () => {
    t = night();
    t.notifier.notify({ ...ref("s1"), cls: "failed" });
    t.notifier.notify({ ...ref("q1"), cls: "approval" });
    await t.step(60_000);
    t.state.judge = (event) => (event.cls === "approval" ? "expired" : "waiting");
    await t.step(TO_MORNING_MS);
    expect(wire(0).body).toBe("1 élément vous attend. 1 demande a expiré pendant les heures calmes.");
  });
});

describe("the digest's own rules", () => {
  async function heldOne(): Promise<void> {
    t = night();
    t.notifier.notify({ ...ref("s1"), cls: "failed" });
    await t.step();
  }

  it("digest-not-held-by-quiet: still sent while quiet hours say quiet", async () => {
    await heldOne();
    t.state.quiet = true;
    await t.step(TO_MORNING_MS);
    expect(states().at(-1)).toBe("digest:sent:");
  });

  it("is sent even when the source no longer lists anything for a digest ref", async () => {
    await heldOne();
    t.state.waitingFor = (event) => event.cls !== "digest";
    await t.step(TO_MORNING_MS);
    expect(states().at(-1)).toBe("digest:sent:");
  });

  it("digest.has-its-own-event: ref kind digest, ref id the owner, the wire id is the event id", async () => {
    await heldOne();
    await t.step(TO_MORNING_MS);
    const row = t.bed.db.get<{ id: string; ref_kind: string; ref_id: string }>(
      "SELECT id, ref_kind, ref_id FROM push_events WHERE cls = 'digest'",
    );
    expect(row).toMatchObject({ ref_kind: "digest", ref_id: OWNER });
    expect(wire(0).id).toBe(row?.id);
  });

  it("is exempt from the hourly cap and not held by its own quiet window", async () => {
    await heldOne();
    for (let i = 0; i < 25; i++)
      t.bed.db.run(
        "INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at, settled_at) VALUES ($id, 'u1', 'failed', 'x', $id, $id, 'sent', $now, $now)",
        { id: `old${i}`, now: MORNING - 1000 },
      );
    await t.step(TO_MORNING_MS);
    expect(t.transport.sent).toHaveLength(1);
  });

  it("suppressed by mute: DROPPED, not re-queued; the Inbox keeps the items", async () => {
    await heldOne();
    t.state.settings = { ...t.state.settings, muteUntil: MORNING + 3_600_000 };
    await t.step(TO_MORNING_MS);
    await t.step(2 * 3_600_000);
    expect(t.transport.sent).toEqual([]);
    expect(states()).toEqual([`failed:digested:${t.events().at(-1)?.id}`, "digest:suppressed:muted"]);
    expect(digestRows()).toHaveLength(1);
  });

  it("suppressed by focus: dropped the same way", async () => {
    await heldOne();
    await t.step(TO_MORNING_MS - 1_000);
    t.presence.report(OWNER, "tab-1", true);
    await t.step(1_000);
    expect(t.transport.sent).toEqual([]);
    expect(states().at(-1)).toBe("digest:suppressed:focused");
    expect(states()[0]).toMatch(/^failed:digested:/);
  });

  it("a second digest waits while the first is still being delivered, then goes", async () => {
    await heldOne();
    t.transport.next({ kind: "retry", afterMs: 120_000 });
    await t.step(TO_MORNING_MS);
    expect(states().at(-1)).toBe("digest:pending:");
    // A new night's hold (quiet hours changed), a minute later: its digest finds the first one still pending and waits.
    t.state.quiet = true;
    await t.step(61_000);
    t.notifier.notify({ ...ref("s2"), cls: "failed" });
    await t.step();
    expect(states().filter((s) => s.startsWith("digest"))).toEqual(["digest:pending:"]);
    expect(states()).toContain("failed:held:");
    await t.step(75_000);
    await t.step(30_000);
    expect(states().filter((s) => s.startsWith("digest"))).toEqual(["digest:sent:", "digest:sent:"]);
    expect(wire(2).body).toBe("1 élément vous attend.");
  });

  it("a replayed digest.send after it ran makes no second digest", async () => {
    await heldOne();
    await t.step(TO_MORNING_MS);
    t.bed.db.run("UPDATE outbox SET status = 'pending', settled_at = NULL WHERE kind = 'digest.send'");
    await t.step();
    expect(states().filter((s) => s.startsWith("digest"))).toHaveLength(1);
    expect(t.transport.sent).toHaveLength(1);
  });
});
