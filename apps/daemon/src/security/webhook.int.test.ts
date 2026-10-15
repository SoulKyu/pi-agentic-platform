import { connect } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../kernel/clock.ts";
import { openDatabase } from "../kernel/db/database.ts";
import { startTestDaemon, type TestDaemon } from "../testing/harness.ts";
import { httpRequest } from "../testing/http-client.ts";
import {
  alertBody,
  bearer,
  type Created,
  createTrigger,
  deliver,
  journalOf,
  openOwner,
  outcome,
  type Owner,
  rows,
  setAutomation,
  sign,
  taskRows,
  webhookInput,
} from "./testing/automation-bed.ts";

// Roadmap M10 exit criterion, spec C §8.1: the webhook route against the real daemon over HTTP (M10R78). Each case
// owns its trigger, so the per-trigger backoff and rate never leak from one case into the next.

const SCRIPT = { steps: [{ text: "Looked at the alert." }] };
const FOREIGN = "https://evil.test";
/** The files whose timers a read-only daemon must never arm: the outbox, the scheduler and the housekeeping. */
const WATCHED = [
  "/kernel/outbox/worker.ts",
  "/modules/automation/scheduler.ts",
  "/modules/automation/housekeeping.ts",
];

/** A fake clock that remembers which of the watched files asked it for a timer (by the caller's stack). */
function watchedClock() {
  const clock = createFakeClock();
  const armedBy = new Set<string>();
  return {
    clock: {
      ...clock,
      setTimeout(fn: () => void, ms: number) {
        const stack = new Error().stack ?? "";
        for (const file of WATCHED) if (stack.includes(file)) armedBy.add(file);
        return clock.setTimeout(fn, ms);
      },
    },
    advance: clock.advance,
    armedBy: () => [...armedBy].sort(),
  };
}

const OLD_PENDING = '{"day":"2026-01-01"}';
const OLD_DONE = '{"day":"2025-01-01"}';

let t: TestDaemon;
let owner: Owner;
beforeAll(async () => {
  t = await startTestDaemon(SCRIPT);
  owner = await openOwner(t);
});
afterAll(async () => {
  owner.client.close();
  await t.stop();
});

const tasksOf = (triggerId: string) =>
  rows<{ id: string }>(t.home, "SELECT id FROM tasks WHERE trigger_id = ?", triggerId);

describe("authentication comes first", () => {
  it("answers a bad secret 401, starts no task and counts it in the journal", async () => {
    const { id } = await createTrigger(owner.client, webhookInput(t));
    for (const headers of [bearer("pwh_wrong"), { "x-pap-secret": "pwh_wrong" }, {}]) {
      const reply = await deliver(t, id, headers, alertBody("DiskFull"));
      expect([reply.status, reply.json]).toEqual([401, { error: { code: "unauthenticated" } }]);
    }
    expect(tasksOf(id)).toEqual([]);
    expect(await journalOf(owner.client, id)).toEqual([
      expect.objectContaining({ verdict: "unauthorized", count: 3 }),
    ]);
  });

  it("checks an HMAC trigger on the raw body, and refuses a wrong, a missing or a body-altered signature", async () => {
    const { id, secret } = await createTrigger(
      owner.client,
      webhookInput(t, { source: { auth: "hmac", format: "raw" } }),
    );
    const body = JSON.stringify({ text: "restart the cache" });
    const signed = { "x-pap-signature-256": sign(secret, body) };
    for (const [name, headers, sent] of [
      ["a wrong signature", { "x-pap-signature-256": sign("pwh_other", body) }, body],
      ["no signature", {}, body],
      ["the secret instead of a signature", bearer(secret), body],
      ["a signature of another body", signed, JSON.stringify({ text: "restart the database" })],
    ] as const) {
      const reply = await deliver(t, id, headers, sent);
      expect([name, reply.status]).toEqual([name, 401]);
    }
    expect(tasksOf(id)).toEqual([]);
    expect((await deliver(t, id, signed, body)).status).toBe(202);
    expect(tasksOf(id)).toHaveLength(1);
  });

  it("refuses to create a trigger that needs both a secret and an HMAC (owner m10a5)", async () => {
    const input = JSON.parse(JSON.stringify(webhookInput(t, { name: "Both" }))) as {
      source: { auth: string };
    };
    input.source.auth = "secret+hmac";
    const refused = await owner.client.call("automation.triggers.create", { input: input as never });
    expect(outcome(refused)).toBe("bad_request");
    expect(rows(t.home, "SELECT id FROM triggers WHERE name = 'Both'")).toEqual([]);
  });

  it("ignores the owner's cookie: a hook with a session cookie and no secret is 401", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t));
    const withCookie = await deliver(t, id, { cookie: owner.cookie, origin: t.origin }, alertBody("A"));
    expect(withCookie.status).toBe(401);
    // The cookie adds nothing beside a wrong secret either, and does not stand in for the right one.
    const wrong = await deliver(t, id, { cookie: owner.cookie, ...bearer("pwh_wrong") }, alertBody("A"));
    expect(wrong.status).toBe(401);
    expect((await deliver(t, id, { cookie: owner.cookie, ...bearer(secret) }, alertBody("A"))).status).toBe(
      202,
    );
  });

  it("answers an unknown id 404 and never takes an upper-case or malformed id, whatever secret it carries", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t));
    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await deliver(t, unknown, bearer(secret), alertBody("A"))).status).toBe(404);
    // Not a hook request at all: without an Origin the browser guard refuses it (403), with ours the route does (404).
    for (const bad of [id.toUpperCase(), "does-not-exist", `${id}/x`]) {
      expect((await deliver(t, bad, bearer(secret), alertBody("A"))).status, bad).toBe(403);
      expect(
        (await deliver(t, bad, { ...bearer(secret), origin: t.origin }, alertBody("A"))).status,
        bad,
      ).toBe(404);
    }
    expect(tasksOf(id)).toEqual([]);
  });

  it("lets ten bad secrets block the guessers, never the sender who has the right one (RT-01)", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t));
    for (let guess = 0; guess < 10; guess++)
      expect((await deliver(t, id, bearer(`pwh_guess${guess}`), alertBody("A"))).status).toBe(401);
    // The block is on: another guess is told to back off, and so is a repeat of a guess.
    expect(await deliver(t, id, bearer("pwh_guess_eleven"), alertBody("A"))).toMatchObject({
      status: 429,
      json: { reason: "backoff" },
    });
    expect((await deliver(t, id, bearer(secret), alertBody("A"))).status).toBe(202);
  });
});

describe("the body is counted as it streams", () => {
  const MAX = 65_536;
  const rawBody = (bytes: number) => JSON.stringify({ text: "x".repeat(bytes - 11) });

  it("answers 413 for 64 KiB + 1 with a declared length, and again when no length is declared", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t, { source: { format: "raw" } }));
    const body = rawBody(MAX + 1);
    expect(Buffer.byteLength(body)).toBe(MAX + 1);
    const declared = await deliver(t, id, { ...bearer(secret), "content-length": String(MAX + 1) }, body);
    expect([declared.status, declared.json]).toEqual([413, { error: { code: "payload_too_large" } }]);
    // No Content-Length: node:http sends it chunked, and only the count of the streamed bytes can refuse it.
    const chunked = await deliver(t, id, bearer(secret), body);
    expect([chunked.status, chunked.json]).toEqual([413, { error: { code: "payload_too_large" } }]);
    expect(tasksOf(id)).toEqual([]);
  });

  it("closes the socket of a refused 50 MB delivery long before the body is sent (RT-02)", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t, { source: { format: "raw" } }));
    const socket = connect(t.port, "127.0.0.1");
    let reply = "";
    let sent = 0;
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    socket.on("data", (chunk) => (reply += chunk.toString("utf8")));
    socket.on("error", () => undefined);
    const head =
      `POST /hooks/${id} HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${secret}\r\n` +
      `content-type: application/json\r\ncontent-length: ${50 * 1024 * 1024}\r\n\r\n`;
    sent += head.length;
    socket.write(head);
    // The route's read deadline is 10 s: closing at once is the declared-length refusal, not the deadline.
    const started = Date.now();
    await Promise.race([
      closed,
      new Promise((_, fail) => setTimeout(() => fail(new Error("the socket stayed open")), 4_000)),
    ]);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(reply).toMatch(/^HTTP\/1\.1 413 /);
    expect(sent).toBeLessThan(1_024);
    expect(tasksOf(id)).toEqual([]);
  });
});

describe("what a delivery becomes", () => {
  it("answers 202 with the task, then 409 dedup for the same signed body, with one task in all", async () => {
    const { id, secret } = await createTrigger(
      owner.client,
      webhookInput(t, { source: { auth: "hmac", format: "raw" } }),
    );
    const body = JSON.stringify({ text: "disk 91% on db1" });
    const headers = { "x-pap-signature-256": sign(secret, body) };
    const first = await deliver(t, id, headers, body);
    expect(first.status).toBe(202);
    expect(first.json).toEqual({ taskId: expect.any(String) });
    const again = await deliver(t, id, headers, body);
    expect([again.status, again.json]).toEqual([409, { reason: "dedup" }]);
    expect(tasksOf(id)).toEqual([{ id: first.json.taskId }]);
    expect(await journalOf(owner.client, id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ verdict: "dedup" })]),
    );
  });

  it("works with no Origin and with a foreign Origin, while the login with that Origin is 403", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t));
    expect((await deliver(t, id, bearer(secret), alertBody("NoOrigin", "n1"))).status).toBe(202);
    expect(
      (await deliver(t, id, { ...bearer(secret), origin: FOREIGN }, alertBody("Foreign", "f9"))).status,
    ).toBe(202);
    const login = await httpRequest(`${t.base}/auth/login`, {
      method: "POST",
      headers: { origin: FOREIGN, "content-type": "application/json" },
      body: JSON.stringify({ username: "owner", password: "correct horse battery staple" }),
    });
    expect(login.status).toBe(403);
  });

  it("refuses with a closed reason while automation is paused, the trigger is off or the budget is 0", async () => {
    const { id, secret } = await createTrigger(owner.client, webhookInput(t));
    const off = await createTrigger(owner.client, webhookInput(t, { enabled: false }));
    const post = (alert: string) => deliver(t, id, bearer(secret), alertBody(alert, alert));
    try {
      await setAutomation(owner.client, { paused: true });
      expect(await post("Paused")).toMatchObject({ status: 409, json: { reason: "paused" } });
      await setAutomation(owner.client, { paused: false, dailyBudgetUsd: 0 });
      expect(await post("Budget")).toMatchObject({ status: 409, json: { reason: "budget" } });
    } finally {
      await setAutomation(owner.client, { paused: false, dailyBudgetUsd: 5 });
    }
    expect(await deliver(t, off.id, bearer(off.secret), alertBody("Off"))).toMatchObject({
      status: 409,
      json: { reason: "disabled" },
    });
    expect(await deliver(t, id, bearer(secret), alertBody("Done", "r1", "resolved"))).toMatchObject({
      status: 409,
      json: { reason: "resolved" },
    });
    expect(tasksOf(id)).toEqual([]);
    expect(tasksOf(off.id)).toEqual([]);
  });
});

describe("a daemon on a database written by a newer pap", () => {
  it("answers 503 read_only, and booted with no outbox, scheduler or housekeeping timer", async () => {
    const home = mkdtempSync(join(tmpdir(), "pap-hook-ro-"));
    const clock = createFakeClock();
    const first = await startTestDaemon(SCRIPT, { config: { home }, deps: { clock } });
    let hook: Created;
    try {
      const mine = await openOwner(first);
      hook = await createTrigger(mine.client, webhookInput(first));
      // A schedule due within two hours: a writable daemon fires it once the clock passes it.
      await createTrigger(mine.client, {
        name: "Midnight",
        enabled: true,
        source: {
          type: "schedule",
          rrule: "FREQ=DAILY;BYHOUR=0;BYMINUTE=0",
          timezone: "UTC",
          catchUp: "skip",
        },
        execution: { cwd: first.cwd },
        prompt: "Check the night.",
      });
    } finally {
      await first.stop();
    }
    const db = openDatabase(join(home, "state.db"));
    try {
      db.run(
        `INSERT INTO outbox (kind, replay, payload, status, next_at, created_at)
         VALUES ('attachment.cleanup', 'replay-safe', '${OLD_PENDING}', 'pending', 0, 0)`,
      );
      db.run(
        `INSERT INTO outbox (kind, replay, payload, status, next_at, created_at, settled_at)
         VALUES ('attachment.cleanup', 'replay-safe', '${OLD_DONE}', 'done', 0, 0, 0)`,
      );
      db.run(
        "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('future/202699990000_x.sql', 'x', 0)",
      );
    } finally {
      db.close();
    }
    const outbox = () =>
      rows<{ status: string; payload: string }>(home, "SELECT status, payload FROM outbox ORDER BY id");

    const readOnlyClock = watchedClock();
    const readOnly = await startTestDaemon(SCRIPT, {
      config: { home },
      deps: { clock: readOnlyClock.clock },
    });
    try {
      const reply = await deliver(readOnly, hook.id, bearer(hook.secret), alertBody("ReadOnly"));
      expect([reply.status, reply.json]).toEqual([503, { error: { code: "read_only" } }]);
      // Two hours on the daemon's own clock: nothing was armed, so nothing ran.
      expect(readOnlyClock.armedBy()).toEqual([]);
      await readOnlyClock.advance(2 * 3_600_000);
      expect(readOnlyClock.armedBy()).toEqual([]);
      expect(outbox().map((row) => [row.payload, row.status])).toEqual([
        [OLD_PENDING, "pending"],
        [OLD_DONE, "done"],
      ]);
      expect(rows(home, "SELECT id FROM tasks")).toEqual([]);
    } finally {
      await readOnly.stop();
    }

    // The same database, writable: the pending row runs and the old settled row is purged, so the guard was the cause.
    const db2 = openDatabase(join(home, "state.db"));
    try {
      db2.run("DELETE FROM schema_migrations WHERE id LIKE 'future/%'");
    } finally {
      db2.close();
    }
    const writableClock = watchedClock();
    const writable = await startTestDaemon(SCRIPT, {
      config: { home },
      deps: { clock: writableClock.clock },
    });
    try {
      expect(writableClock.armedBy()).toEqual([...WATCHED].sort());
      await writableClock.advance(2 * 3_600_000);
      await vi.waitFor(() => expect(outbox().map((row) => row.status)).not.toContain("pending"), {
        timeout: 10_000,
      });
      expect(outbox().map((row) => row.payload)).not.toContain(OLD_DONE);
      expect(taskRows(home).length).toBeGreaterThan(0);
    } finally {
      await writable.stop();
      rmSync(home, { recursive: true, force: true });
    }
  }, 90_000);
});
