import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createOutbox, type Outbox } from "../../../kernel/outbox/index.ts";
import { openOutboxBed, type OutboxBed } from "../../../kernel/testing/outbox-bed.ts";
import { PUSH_MIGRATIONS, type PushNotifier } from "../index.ts";
import { createNotifier } from "./notifier.ts";

let bed: OutboxBed;
let outbox: Outbox;
let notifier: PushNotifier;
beforeEach(() => {
  bed = openOutboxBed([PUSH_MIGRATIONS]);
  outbox = createOutbox({ db: bed.db, clock: bed.clock, logger: bed.logger, readOnly: false });
  notifier = createNotifier({ db: bed.db, clock: bed.clock, outbox, readOnly: false });
});
afterEach(() => bed.close());

const ref = { ownerId: "u1", refKind: "session", refId: "s1" } as const;
interface OutboxRow {
  id: number;
  kind: string;
  dedup_key: string;
  next_at: number;
  status: string;
  payload: string;
}
const outboxRows = () => bed.db.all<OutboxRow>("SELECT * FROM outbox ORDER BY id");
const events = () =>
  bed.db.all<{ id: string; state: string; reason: string | null; dedup_key: string; name: string | null }>(
    "SELECT id, state, reason, dedup_key, name FROM push_events ORDER BY created_at, id",
  );

describe("notify", () => {
  it("writes one event and one outbox row, keyed apart", () => {
    const result = notifier.notify({ ...ref, cls: "failed" });
    expect(result).not.toBeNull();
    const id = result?.id ?? "";
    expect(events()).toEqual([
      { id, state: "pending", reason: null, dedup_key: "push:failed:session:s1", name: null },
    ]);
    const rows = outboxRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "push.send", dedup_key: `push.send:${id}`, status: "pending" });
    expect(JSON.parse(rows[0]?.payload ?? "{}")).toEqual({ eventId: id });
    expect(rows[0]?.dedup_key).not.toBe("push:failed:session:s1");
  });

  it("ids are 22 base64url characters", () => {
    const id = notifier.notify({ ...ref, cls: "failed" })?.id ?? "";
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });

  it("delays an approval by 60 s and sends everything else now", () => {
    const now = bed.clock.now();
    notifier.notify({ ...ref, cls: "approval" });
    notifier.notify({ ...ref, cls: "failed" });
    const [approval, failed] = outboxRows();
    expect(approval?.next_at).toBe(now + 60_000);
    expect(failed?.next_at).toBe(now);
  });

  it("honours an explicit `at` for a non-approval", () => {
    const now = bed.clock.now();
    notifier.notify({ ...ref, cls: "budget", at: now + 5_000 });
    expect(outboxRows()[0]?.next_at).toBe(now + 5_000);
  });

  it("returns null for a live duplicate and adds no row", () => {
    notifier.notify({ ...ref, cls: "failed" });
    expect(notifier.notify({ ...ref, cls: "failed" })).toBeNull();
    expect(events()).toHaveLength(1);
    expect(outboxRows()).toHaveLength(1);
  });

  it("second-question-pushes-again: a settled event does not swallow the next push", () => {
    const first = notifier.notify({ ...ref, cls: "approval" });
    expect(first).not.toBeNull();
    bed.db.run("UPDATE push_events SET state = 'sent' WHERE id = $id", { id: first?.id ?? "" });
    bed.db.run("UPDATE outbox SET status = 'done', settled_at = 1 WHERE kind = 'push.send'");
    const second = notifier.notify({ ...ref, cls: "approval" });
    expect(second).not.toBeNull();
    expect(second?.id).not.toBe(first?.id);
    expect(events()).toHaveLength(2);
    expect(outboxRows()).toHaveLength(2);
  });

  it("rolls the event back when the outbox refuses the effect", () => {
    // Pre-insert an outbox row with the key the event would get: impossible by id, so force it with a fixed token.
    const preset = createNotifier({
      db: bed.db,
      clock: bed.clock,
      outbox,
      readOnly: false,
      newId: () => "abcdefghijklmnopqrstuv",
    });
    bed.db.run(
      `INSERT INTO outbox (kind, replay, owner_id, payload, dedup_key, status, next_at, created_at, settled_at)
       VALUES ('push.send', 'replay-safe', 'u1', '{"eventId":"abcdefghijklmnopqrstuv"}', 'push.send:abcdefghijklmnopqrstuv', 'done', 0, 0, 0)`,
    );
    expect(preset.notify({ ...ref, cls: "failed" })).toBeNull();
    expect(events()).toEqual([]);
    expect(outboxRows()).toHaveLength(1);
  });

  it("leaves nothing behind when the effect is refused inside an outer transaction", () => {
    const preset = createNotifier({
      db: bed.db,
      clock: bed.clock,
      outbox,
      readOnly: false,
      newId: () => "abcdefghijklmnopqrstuv",
    });
    bed.db.run(
      `INSERT INTO outbox (kind, replay, owner_id, payload, dedup_key, status, next_at, created_at, settled_at)
       VALUES ('push.send', 'replay-safe', 'u1', '{"eventId":"abcdefghijklmnopqrstuv"}', 'push.send:abcdefghijklmnopqrstuv', 'done', 0, 0, 0)`,
    );
    bed.db.transaction(() => {
      expect(preset.notify({ ...ref, cls: "failed" })).toBeNull();
    });
    expect(events()).toEqual([]);
  });

  it("clips a long registry name at insert", () => {
    notifier.notify({ ...ref, cls: "failed", name: `Ni\u202e${"x".repeat(100)}` });
    expect(events()[0]?.name).toBe("x".repeat(60).replace(/^/, "Ni").slice(0, 60));
  });

  it("is a no-op in read-only mode", () => {
    const readOnly = createNotifier({ db: bed.db, clock: bed.clock, outbox, readOnly: true });
    expect(readOnly.notify({ ...ref, cls: "failed" })).toBeNull();
    expect(events()).toEqual([]);
    expect(outboxRows()).toEqual([]);
  });

  it("keeps a registry name as given (the copy cleans it)", () => {
    notifier.notify({ ...ref, cls: "failed", name: "Nightly" });
    expect(events()[0]?.name).toBe("Nightly");
  });

  it("builds the key from class and ref", () => {
    expect(notifier.keyOf("approval", "session", "s9")).toBe("push:approval:session:s9");
  });
});

describe("cancel", () => {
  it("retires the pending outbox row and marks the event", () => {
    const id = notifier.notify({ ...ref, cls: "approval" })?.id ?? "";
    notifier.cancel("push:approval:session:s1", "answered");
    expect(events()[0]).toMatchObject({ id, state: "cancelled", reason: "answered" });
    expect(outboxRows()[0]?.status).toBe("retired");
  });

  it("marks a leased row for the handler's next check", () => {
    notifier.notify({ ...ref, cls: "approval" });
    bed.db.run("UPDATE outbox SET status = 'leased', lease_until = $until", {
      until: bed.clock.now() + 30_000,
    });
    notifier.cancel("push:approval:session:s1", "gone");
    expect(events()[0]).toMatchObject({ state: "cancelled", reason: "gone" });
    expect(outboxRows()[0]?.status).toBe("leased");
    expect(bed.db.get("SELECT cancel_requested FROM outbox")).toEqual({ cancel_requested: 1 });
  });

  it("leaves a held event alone", () => {
    notifier.notify({ ...ref, cls: "approval" });
    bed.db.run("UPDATE push_events SET state = 'held'");
    notifier.cancel("push:approval:session:s1", "expired");
    expect(events()[0]?.state).toBe("held");
    expect(outboxRows()[0]?.status).toBe("pending");
  });

  it("does nothing for an unknown key", () => {
    notifier.notify({ ...ref, cls: "approval" });
    notifier.cancel("push:approval:session:other", "gone");
    expect(events()[0]?.state).toBe("pending");
  });

  it("lets the ref push again once cancelled", () => {
    notifier.notify({ ...ref, cls: "approval" });
    notifier.cancel("push:approval:session:s1", "answered");
    expect(notifier.notify({ ...ref, cls: "approval" })).not.toBeNull();
  });
});
