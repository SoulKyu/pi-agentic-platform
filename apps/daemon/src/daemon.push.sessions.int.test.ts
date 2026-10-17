import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { AUTOMATION_READ_TOOLS, PushWire, TriggerInput } from "@pap/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakeClock, type FakeClock } from "./kernel/clock.ts";
import { KILLER } from "./modules/sessions/testing/extensions.ts";
import { createFakeTransport, type FakeTransport } from "./modules/push/testing/fake-transport.ts";
import {
  createMemorySubscriptions,
  type MemorySubscriptions,
} from "./modules/push/testing/memory-subscriptions.ts";
import { createTrigger, openOwner, type Owner, result, rows } from "./security/testing/automation-bed.ts";
import { dialogIdOf, isDialog, lookupTool, sessionIdOf } from "./security/testing/fixtures.ts";
import { startTestDaemon, type TestDaemon } from "./testing/harness.ts";
import type { TestClient } from "./testing/ws-client.ts";

// M12 task 11 through a whole daemon: real workers on the scripted provider, the fake Clock and the fake push transport.
// An approval is a dialog the worker opened; the attention feed reports it, the source pushes 60 s later if it still waits.

/** The command is the one thing that must never reach a push: none of its words is in a body. */
const COMMAND = "env echo zq9x-private-token";
const WORDS = ["zq9x", "private", "token"];
const ASKS = {
  steps: [{ toolCalls: [{ name: "bash", args: { command: COMMAND }, id: "c1" }] }, { text: "done" }],
};

let t: TestDaemon;
let owner: Owner;
let ownerId: string;
let clock: FakeClock;
let transport: FakeTransport;
let subs: MemorySubscriptions;
const clients: TestClient[] = [];

const script = (value: object): void => writeFileSync(join(t.root, "script.json"), JSON.stringify(value));
const settled = (check: () => unknown) => vi.waitFor(check, { timeout: 30_000 });

beforeAll(async () => {
  clock = createFakeClock();
  transport = createFakeTransport();
  subs = createMemorySubscriptions();
  t = await startTestDaemon(ASKS, {
    extensions: { killer: KILLER, lookup: lookupTool("a page") },
    config: { maxWorkers: 8 },
    deps: { clock, push: { transport, subscriptions: subs, sessionLive: subs } },
  });
  owner = await openOwner(t);
  clients.push(owner.client);
  ownerId = rows<{ id: string }>(t.home, "SELECT id FROM users")[0]?.id ?? "";
  subs.add(ownerId, {
    id: "phone",
    endpoint: "https://push.example.net/phone",
    p256dh: "p",
    auth: "a",
    credentialId: "c-phone",
    locale: "en",
  });
}, 60_000);
afterAll(async () => {
  for (const client of clients) client.close();
  await t.stop();
});

const events = (sessionId: string) =>
  rows<{ id: string; state: string; reason: string | null; rechecks: number; ref_kind: string }>(
    t.home,
    "SELECT id, state, reason, rechecks, ref_kind FROM push_events WHERE cls = 'approval' AND ref_id = ? ORDER BY rowid",
    sessionId,
  );
const states = (sessionId: string) =>
  events(sessionId).map((e) => e.state + (e.reason ? `:${e.reason}` : ""));

async function connect(): Promise<TestClient> {
  const client = await t.connect(owner.cookie);
  clients.push(client);
  return client;
}

/** A session whose prompt makes the worker ask; resolves once the card is open and the push is waiting for its 60 s. */
async function asking(client: TestClient): Promise<{ sessionId: string; dialogId: string }> {
  const sessionId = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
  expect((await client.call("subscribe.session", { sessionId })).ok).toBe(true);
  expect((await client.call("sessions.prompt", { sessionId, text: "go" })).ok).toBe(true);
  const dialogId = dialogIdOf(await client.waitForEvent(isDialog, 45_000));
  await settled(() => expect(states(sessionId)).toEqual(["pending"]));
  return { sessionId, dialogId };
}

const answer = async (client: TestClient, sessionId: string, dialogId: string) =>
  expect(
    (await client.call("sessions.respondDialog", { sessionId, dialogId, response: { answer: "once" } })).ok,
  ).toBe(true);
const sentCount = () => transport.sent.length;

describe("a session asking for approval (M12R23)", () => {
  it("pushes once after 60 s, and the wire carries no part of the command", async () => {
    const client = await connect();
    const { sessionId, dialogId } = await asking(client);
    const before = sentCount();
    await clock.advance(59_000);
    expect(sentCount()).toBe(before);
    await clock.advance(1_000);
    await settled(() => expect(sentCount()).toBe(before + 1));
    expect(states(sessionId)).toEqual(["sent"]);
    const sent = transport.sent[before];
    const wire = PushWire.parse(JSON.parse(new TextDecoder().decode(sent?.plaintext)));
    expect(wire).toMatchObject({ cls: "approval", title: "pap" });
    const text = new TextDecoder().decode(sent?.plaintext);
    for (const word of WORDS) expect(text).not.toContain(word);
    // The click: the daemon resolves the opaque id to the session's card, and an unknown id is not_found.
    expect(result(await client.call("push.open", { id: wire.id }))).toEqual({
      target: { kind: "session", id: sessionId },
    });
    const unknown = await client.call("push.open", { id: "z".repeat(22) });
    expect(unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
    await answer(client, sessionId, dialogId);
    await settled(() => expect(states(sessionId)).toEqual(["sent"]));
  }, 90_000);

  it("approval.answered-in-window: answering within 59 s sends nothing", async () => {
    const client = await connect();
    const { sessionId, dialogId } = await asking(client);
    const before = sentCount();
    await clock.advance(59_000);
    await answer(client, sessionId, dialogId);
    await settled(() => expect(states(sessionId)).toEqual(["cancelled:answered"]));
    await clock.advance(5_000);
    expect(sentCount()).toBe(before);
  }, 90_000);

  it("focused.recheck: a focused tab holds the push back, and it is sent once the entry lapses", async () => {
    const client = await connect();
    const { sessionId, dialogId } = await asking(client);
    const before = sentCount();
    await clock.advance(30_000);
    expect((await client.call("push.presence", { focused: true })).ok).toBe(true);
    await clock.advance(30_000);
    await settled(() => expect(events(sessionId)[0]?.rechecks).toBe(1));
    expect(sentCount()).toBe(before);
    expect(states(sessionId)).toEqual(["pending"]);
    // 60 s later the 45 s entry has lapsed and the question still waits.
    await clock.advance(60_000);
    await settled(() => expect(sentCount()).toBe(before + 1));
    expect(states(sessionId)).toEqual(["sent"]);
    await answer(client, sessionId, dialogId);
  }, 90_000);

  it("approval.worker-exit-cancels: a worker that dies with the approval open pushes nothing", async () => {
    const client = await connect();
    const { sessionId } = await asking(client);
    const before = sentCount();
    await expect(
      client.call("sessions.prompt", { sessionId, text: "/die" }).then((frame) => frame.ok),
    ).resolves.toBeDefined();
    await client.waitForEvent((f) => (f.event as { status?: string }).status === "cold", 30_000);
    await clock.advance(61_000);
    await settled(() => expect(events(sessionId)[0]?.state).not.toBe("pending"));
    expect(sentCount()).toBe(before);
    expect(events(sessionId)[0]?.state).toBe("cancelled");
  }, 90_000);
});

describe("a subagent child asking (M12R24, verified)", () => {
  it("one push, and its target is the PARENT session", async () => {
    const client = await connect();
    script({
      steps: [
        { toolCalls: [{ name: "subagent", args: { task: "Look" }, id: "sa1" }] },
        { text: "Parent done." },
      ],
    });
    const parent = sessionIdOf(await client.call("sessions.create", { cwd: t.cwd }));
    // The parent's worker has read its script; the next worker is the child's.
    script({
      steps: [{ toolCalls: [{ name: "lookup", args: { q: "x" }, id: "l1" }] }, { text: "child answer" }],
    });
    await settled(async () => {
      const list = result<{ sessions: Array<{ id: string; status: string }> }>(
        await client.call("sessions.list", {}),
      );
      expect(list.sessions.find((s) => s.id === parent)?.status).toBe("idle");
    });
    expect((await client.call("subscribe.session", { sessionId: parent })).ok).toBe(true);
    expect((await client.call("sessions.prompt", { sessionId: parent, text: "Delegate." })).ok).toBe(true);
    await settled(() => expect(states(parent)).toEqual(["pending"]));
    const before = sentCount();
    await clock.advance(60_000);
    await settled(() => expect(sentCount()).toBe(before + 1));
    const wire = PushWire.parse(JSON.parse(new TextDecoder().decode(transport.sent[before]?.plaintext)));
    expect(result(await client.call("push.open", { id: wire.id }))).toEqual({
      target: { kind: "session", id: parent },
    });
    expect(events(parent)).toHaveLength(1);
    script(ASKS);
  }, 120_000);
});

describe("an isolated task's question and the Inbox", () => {
  it("one push, not two: the attention feed and the Inbox item join the session key", async () => {
    const client = await connect();
    await t.confirmStepUp(owner.cookie);
    script(ASKS);
    const { id } = await createTrigger(
      client,
      TriggerInput.parse({
        name: "Check disk",
        source: { type: "manual" },
        execution: { cwd: t.cwd, tools: [...AUTOMATION_READ_TOOLS, "bash"], mode: "supervised" },
        prompt: "Check the disk.",
      }),
    );
    expect((await client.call("subscribe.inbox", {})).ok).toBe(true);
    expect((await client.call("automation.fire", { triggerId: id })).ok).toBe(true);
    await clock.advance(0); // task.start is an outbox effect, due on the Clock
    await client.waitForEvent(
      (f) => (f.event as { item?: { kind?: string } }).item?.kind === "task_needs_input",
      60_000,
    );
    const approvals = () =>
      rows<{ ref_id: string; state: string }>(
        t.home,
        "SELECT ref_id, state FROM push_events WHERE cls = 'approval' AND ref_kind = 'session' AND ref_id IN (SELECT session_id FROM tasks)",
      );
    await settled(() => expect(approvals()).toHaveLength(1));
    const before = sentCount();
    await clock.advance(60_000);
    await settled(() => expect(sentCount()).toBe(before + 1));
    expect(approvals()).toHaveLength(1);
    expect(approvals()[0]?.state).toBe("sent");
  }, 120_000);

  it("a task that fails writes an Inbox item and a push event: the Inbox source is wired in the compose", async () => {
    const client = await connect();
    await t.confirmStepUp(owner.cookie);
    script({ steps: [{ stopReason: "error", errorMessage: "boom" }, { text: "unused" }] });
    const { id } = await createTrigger(
      client,
      TriggerInput.parse({
        name: "Breaks",
        source: { type: "manual" },
        execution: { cwd: t.cwd, tools: [...AUTOMATION_READ_TOOLS], mode: "supervised" },
        prompt: "Break.",
      }),
    );
    expect((await client.call("automation.fire", { triggerId: id })).ok).toBe(true);
    await clock.advance(0);
    await settled(() =>
      expect(
        rows<{ cls: string }>(
          t.home,
          "SELECT p.cls FROM push_events p JOIN inbox_items i ON i.id = p.ref_id WHERE p.ref_kind = 'inbox' AND i.kind = 'task_failed'",
        ),
      ).toEqual([{ cls: "failed" }]),
    );
    script(ASKS);
  }, 120_000);
});
