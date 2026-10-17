import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_READ_TOOLS, TriggerInput, type EventFrame } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { createTrigger, openOwner, type Owner, rows } from "./security/testing/automation-bed.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";

// D19 exit, daemon side (M12R31): a client that drops and resubscribes `after` its cursor gets exactly the Inbox events it
// missed, once, and no snapshot. The supervisor polish is client-only; this pins the stream it relies on.

const FAILS = { steps: [{ stopReason: "error", errorMessage: "boom" }, { text: "unused" }] };

let t: TestDaemon;
let owner: Owner;
let clock: FakeClock;
beforeAll(async () => {
  clock = createFakeClock();
  t = await startTestDaemon(FAILS, { deps: { clock } });
  owner = await openOwner(t);
}, 60_000);
afterAll(async () => {
  owner.client.close();
  await t.stop();
});

const itemOf = (frame: EventFrame) => (frame.event as { item?: { id: string; kind: string } }).item;
const failedItems = () =>
  rows<{ id: string }>(
    t.home,
    "SELECT id FROM inbox_items WHERE kind = 'task_failed' ORDER BY created_at, id",
  );

/** Fires a trigger whose task fails and returns the id of the Inbox item it wrote (the Clock is fixed, so rows share a time). */
async function failOnce(name: string, client = owner.client): Promise<string> {
  const before = failedItems().map((row) => row.id);
  writeFileSync(join(t.root, "script.json"), JSON.stringify(FAILS));
  const { id } = await createTrigger(
    client,
    TriggerInput.parse({
      name,
      source: { type: "manual" },
      execution: { cwd: t.cwd, tools: [...AUTOMATION_READ_TOOLS], mode: "supervised" },
      prompt: "Break.",
    }),
  );
  expect((await client.call("automation.fire", { triggerId: id })).ok).toBe(true);
  await clock.advance(0); // task.start is an outbox effect, due on the Clock
  await vi.waitFor(() => expect(failedItems()).toHaveLength(before.length + 1), { timeout: 60_000 });
  const added = failedItems().find((row) => !before.includes(row.id));
  if (added === undefined) throw new Error("the failed task wrote no Inbox item");
  return added.id;
}

describe("reconnect-resume on the inbox stream", () => {
  it("a client that drops and resubscribes after its cursor receives exactly the missed items once", async () => {
    await t.confirmStepUp(owner.cookie);
    const first = await t.connect(owner.cookie);
    expect((await first.call("subscribe.inbox", {})).ok).toBe(true);
    const one = await failOnce("Break one", first);
    const seen = await first.waitForEvent((f) => itemOf(f)?.kind === "task_failed", 30_000);
    const last = first.events.at(-1) ?? seen;
    const cursor = { epoch: last.epoch, seq: last.seq };
    first.close();
    await first.closed;

    const two = await failOnce("Break two");
    const three = await failOnce("Break three");

    const second = await t.connect(owner.cookie);
    expect((await second.call("subscribe.inbox", { after: cursor })).ok).toBe(true);
    await vi.waitFor(() =>
      expect(second.events.filter((f) => itemOf(f)?.id === three).length).toBeGreaterThan(0),
    );
    const ids = second.events.map((f) => itemOf(f)?.id).filter((id) => id !== undefined);
    expect(second.events.every((f) => (f.event as { kind?: string }).kind !== "snapshot")).toBe(true);
    expect(ids).not.toContain(one);
    expect(ids.filter((id) => id === two)).toHaveLength(1);
    expect(ids.filter((id) => id === three)).toHaveLength(1);
    expect(second.events[0]?.seq).toBe(cursor.seq + 1);
    second.close();
  }, 180_000);
});
