import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { EventFrame } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { startTestDaemon, type TestDaemon } from "../../testing/harness.ts";
import { drainOutboxOf } from "../../testing/usage-seam.ts";
import type { TestClient } from "../../testing/ws-client.ts";

type Event = { kind?: string; limit?: { sessionId: string; resume: string }; rows?: SessionRow[] };
type SessionRow = { message: { role?: string; content?: unknown } };
const kind = (name: string) => (frame: EventFrame) => (frame.event as Event).kind === name;

const LIMIT_TEXT = "You have hit your ChatGPT usage limit (plus plan). Try again in ~1 min.";
let t: TestDaemon | undefined;
afterEach(async () => {
  await t?.stop();
  t = undefined;
});

/** The system clock with a hand: the test moves the daemon past the quota reset without waiting for it. */
function shiftableClock() {
  const shift = { ms: 0 };
  return { shift, clock: { ...createSystemClock(), now: () => Date.now() + shift.ms } };
}

async function openLimited(daemon: TestDaemon): Promise<{ client: TestClient; sessionId: string }> {
  const client = await daemon.connect(await daemon.login());
  expect((await client.call("subscribe.usage", {})).ok).toBe(true);
  await client.waitForEvent(kind("snapshot"));
  const created = await client.call("sessions.create", { cwd: daemon.cwd });
  if (!created.ok) throw new Error(JSON.stringify(created));
  const sessionId = (created.result as { sessionId: string }).sessionId;
  expect((await client.call("subscribe.session", { sessionId })).ok).toBe(true);
  expect((await client.call("sessions.prompt", { sessionId, text: "Do the long job" })).ok).toBe(true);
  const limited = await client.waitForEvent(kind("limit"));
  expect((limited.event as Event).limit).toMatchObject({ sessionId, resume: "scheduled" });
  return { client, sessionId };
}

/** The outbox rows as the daemon wrote them (a read-only look at its database). */
function outboxRows(
  daemon: TestDaemon,
): Array<{ status: string; sent_at: number | null; last_error: string | null }> {
  const db = new DatabaseSync(join(daemon.home, "state.db"), { readOnly: true });
  try {
    return db.prepare("SELECT status, sent_at, last_error FROM outbox ORDER BY id").all() as never;
  } finally {
    db.close();
  }
}

const runLines = (daemon: TestDaemon): Array<Record<string, unknown>> =>
  readFileSync(join(daemon.home, "logs", "runs.jsonl"), "utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

const userTexts = async (client: TestClient, sessionId: string): Promise<string[]> => {
  const before = client.events.length;
  await client.call("subscribe.session", { sessionId });
  const snapshot = await client.waitForEvent(
    (frame) => kind("snapshot")(frame) && client.events.indexOf(frame) >= before,
  );
  return ((snapshot.event as Event).rows ?? [])
    .filter((row) => row.message.role === "user")
    .map((row) => JSON.stringify(row.message.content));
};

describe("a quota-limited run resumes at the reset (scripted provider)", () => {
  it("marks the run limited, then resumes once with the origin resume and T3's text", async () => {
    const { shift, clock } = shiftableClock();
    t = await startTestDaemon(
      { steps: [{ stopReason: "error", errorMessage: LIMIT_TEXT }, { text: "Picked up again." }] },
      { deps: { clock } },
    );
    const { client, sessionId } = await openLimited(t);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(1), { timeout: 20_000 });
    expect(runLines(t)[0]).toMatchObject({ status: "limited", errorClass: "usage_limit", sessionId });

    shift.ms = 5 * 60_000;
    expect(await drainOutboxOf(t.home)?.()).toBe(1);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(2), { timeout: 20_000 });
    expect(runLines(t)[1]).toMatchObject({ status: "completed", origin: "resume", sessionId });

    await client.waitForEvent(kind("limit_cleared"));
    const texts = await userTexts(client, sessionId);
    expect(texts.at(-1)).toContain("Continue where you left off.");
    expect(await drainOutboxOf(t.home)?.()).toBe(0);
    expect(runLines(t)).toHaveLength(2);
  }, 90_000);

  it("skips the resume when the owner prompts first: new input wins, nothing is sent twice", async () => {
    const { shift, clock } = shiftableClock();
    t = await startTestDaemon(
      { steps: [{ stopReason: "error", errorMessage: LIMIT_TEXT }, { text: "Owner answer." }] },
      { deps: { clock } },
    );
    const { client, sessionId } = await openLimited(t);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(1), { timeout: 20_000 });
    expect(
      (await client.call("sessions.prompt", { sessionId, text: "I am back, try this instead" })).ok,
    ).toBe(true);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(2), { timeout: 20_000 });
    expect(runLines(t)[1]).toMatchObject({ status: "completed", origin: "user" });

    shift.ms = 5 * 60_000;
    expect(await drainOutboxOf(t.home)?.()).toBe(1);
    // Skipped before its point of no return: settled done, never marked sent (no run to wait for).
    expect(outboxRows(t)).toEqual([expect.objectContaining({ status: "done", sent_at: null })]);
    expect(runLines(t)).toHaveLength(2);
    const texts = await userTexts(client, sessionId);
    expect(texts.some((text) => text.includes("Continue where you left off."))).toBe(false);
    expect(texts.at(-1)).toContain("I am back");
  }, 90_000);

  it("resumes at once on usage.resumeNow, and the scheduled effect never sends a second time", async () => {
    const { shift, clock } = shiftableClock();
    t = await startTestDaemon(
      { steps: [{ stopReason: "error", errorMessage: LIMIT_TEXT }, { text: "Now." }] },
      { deps: { clock } },
    );
    const { client, sessionId } = await openLimited(t);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(1), { timeout: 20_000 });
    expect(await client.call("usage.resumeNow", { sessionId })).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(2), { timeout: 20_000 });
    // The owner's click is the owner's own run (I5), and the scheduled effect was retired as cancelled (not merely skipped).
    expect(runLines(t)[1]).toMatchObject({ origin: "user", status: "completed" });
    expect(outboxRows(t)).toEqual([expect.objectContaining({ status: "retired", last_error: "cancelled" })]);
    shift.ms = 5 * 60_000;
    expect(await drainOutboxOf(t.home)?.()).toBe(0);
    expect(runLines(t)).toHaveLength(2);
  }, 90_000);

  it("defers the resume while the owner's prompt reopens the cold session: their run keeps its own origin (I1)", async () => {
    const { shift, clock } = shiftableClock();
    t = await startTestDaemon(
      { steps: [{ stopReason: "error", errorMessage: LIMIT_TEXT }, { text: "Owner answer." }] },
      { deps: { clock }, config: { workerIdleMs: 200 } },
    );
    const { client, sessionId } = await openLimited(t);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(1), { timeout: 20_000 });
    await client.waitForEvent((frame) => (frame.event as { status?: string }).status === "cold");
    shift.ms = 5 * 60_000;
    const reopened = client.events.length;
    const prompted = client.call("sessions.prompt", { sessionId, text: "I am back, try this instead" });
    await client.waitForEvent(
      (frame) =>
        (frame.event as { status?: string }).status === "starting" &&
        client.events.indexOf(frame) >= reopened,
    );
    // The reopen is in flight and the owner's run has not started: the resume looks and steps aside.
    expect(await drainOutboxOf(t.home)?.()).toBe(1);
    expect(outboxRows(t)).toEqual([expect.objectContaining({ status: "pending", sent_at: null })]);
    expect((await prompted).ok).toBe(true);
    await vi.waitFor(() => expect(runLines(t as TestDaemon)).toHaveLength(2), { timeout: 20_000 });
    // (The reopened worker replays the script from its first step, so this run is limited again; its origin is the point.)
    expect(runLines(t).map((line) => line.origin)).toEqual(["user", "user"]);
  }, 90_000);
});
