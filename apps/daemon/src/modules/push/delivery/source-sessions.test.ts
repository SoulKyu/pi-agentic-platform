import { NotificationsSettings, PushWire } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import { createAutomationEvents } from "../../automation/index.ts";
import { createInbox, INBOX_MIGRATIONS } from "../../inbox/index.ts";
import { OWNER, openSendBed, type SendBed } from "../testing/send-bed.ts";
import type { PushNotifier } from "../service.ts";
import type { EventRow } from "./events.ts";
import { wireInboxSource } from "./source-inbox.ts";
import { wireSessionSource } from "./source-sessions.ts";

let t: SendBed;
let stop: () => void = () => {};
afterEach(() => {
  stop();
  t.close();
});

type Listener = (sessionId: string, needsInput: boolean) => void;
interface Fake {
  readonly owners: Map<string, string>;
  readonly states: Map<string, { archived: boolean; running: boolean; needsInput: boolean }>;
  readonly agents: Map<string, string>;
  readonly parents: Map<string, string>;
  readonly listeners: Set<Listener>;
  report(sessionId: string, needsInput: boolean): void;
  add(sessionId: string, owner?: string, agentId?: string): void;
}

/** The two things of the sessions module the source reads, with the attention feed in the test's hands. */
function fakeSessions(): { fake: Fake; sessions: Parameters<typeof wireSessionSource>[0]["sessions"] } {
  const fake: Fake = {
    owners: new Map(),
    states: new Map(),
    agents: new Map(),
    parents: new Map(),
    listeners: new Set(),
    report: (id, needsInput) => {
      for (const listener of [...fake.listeners]) listener(id, needsInput);
    },
    add(id, owner = OWNER, agentId) {
      fake.owners.set(id, owner);
      fake.states.set(id, { archived: false, running: true, needsInput: true });
      if (agentId !== undefined) fake.agents.set(id, agentId);
    },
  };
  return {
    fake,
    sessions: {
      ownerOf: (id) => fake.owners.get(id) ?? null,
      kindOf: (id) =>
        fake.agents.has(id) || fake.parents.has(id)
          ? { agentId: fake.agents.get(id) ?? null, parentSessionId: fake.parents.get(id) ?? null }
          : null,
      automation: {
        onAttention: (listener) => {
          fake.listeners.add(listener);
          return () => void fake.listeners.delete(listener);
        },
        state: (ownerId, id) => (fake.owners.get(id) === ownerId ? (fake.states.get(id) ?? null) : null),
      },
    },
  };
}

function rig(agentName?: (ownerId: string, agentId: string) => string | null) {
  t = openSendBed(["a"]);
  const { fake, sessions } = fakeSessions();
  const notified: Array<Record<string, unknown>> = [];
  const spy: PushNotifier = {
    ...t.notifier,
    notify: (event) => {
      notified.push(event);
      return t.notifier.notify(event);
    },
  };
  const source = wireSessionSource({ sessions, notifier: spy, logger: t.bed.logger, agentName });
  stop = source.stop;
  t.state.waitingFor = (event) => source.waiting(event);
  t.state.judge = (event) => source.verdict(event);
  return { fake, source, notified };
}

const pushes = () =>
  t.bed.db.all<{ cls: string; ref_kind: string; ref_id: string; name: string | null; state: string }>(
    "SELECT cls, ref_kind, ref_id, name, state, reason, dedup_key FROM push_events ORDER BY created_at, rowid",
  );
const states = () => pushes().map((row) => `${row.ref_id}:${row.state}`);
const wire = (call = 0) =>
  PushWire.parse(JSON.parse(new TextDecoder().decode(t.transport.sent[call]?.plaintext)));

describe("an attention report becomes one approval push per session (M12R23)", () => {
  it("true notifies once, 60 s late, under the key push:approval:session:<id>", async () => {
    const { fake } = rig();
    fake.add("s1");
    fake.report("s1", true);
    expect(t.bed.db.get("SELECT dedup_key FROM push_events")).toEqual({
      dedup_key: "push:approval:session:s1",
    });
    await t.step(59_999);
    expect(t.transport.sent).toEqual([]);
    await t.step(1);
    expect(t.transport.sent).toHaveLength(1);
    expect(wire()).toMatchObject({ cls: "approval", title: "pap" });
    expect(states()).toEqual(["s1:sent"]);
  });

  it("approval.answered-in-window: false cancels it and nothing is sent", async () => {
    const { fake } = rig();
    fake.add("s1");
    fake.report("s1", true);
    await t.step(59_000);
    fake.report("s1", false);
    await t.step(5_000);
    expect(t.transport.sent).toEqual([]);
    expect(t.bed.db.get("SELECT state, reason FROM push_events")).toEqual({
      state: "cancelled",
      reason: "answered",
    });
  });

  it("two sessions waiting produce two events, and answering one leaves the other", async () => {
    const { fake } = rig();
    fake.add("s1");
    fake.add("s2");
    fake.report("s1", true);
    fake.report("s2", true);
    fake.report("s1", false);
    await t.step(60_000);
    expect(states()).toEqual(["s1:cancelled", "s2:sent"]);
    expect(t.transport.sent).toHaveLength(1);
  });

  it("a session asking a second time pushes again once the first push settled", async () => {
    const { fake } = rig();
    fake.add("s1");
    fake.report("s1", true);
    await t.step(60_000);
    fake.report("s1", false);
    await t.step(10_000);
    fake.report("s1", true);
    await t.step(60_000);
    expect(states()).toEqual(["s1:sent", "s1:sent"]);
  });

  it("a child's open approval is reported on the PARENT and the push is the parent's (M12R24)", async () => {
    const { fake, notified } = rig();
    fake.add("parent");
    fake.report("parent", true);
    expect(notified).toEqual([{ ownerId: OWNER, cls: "approval", refKind: "session", refId: "parent" }]);
    await t.step(60_000);
    expect(t.transport.sent).toHaveLength(1);
  });

  it("a child's own report is skipped: its question is the parent's push, opened on the parent", async () => {
    const { fake } = rig();
    fake.add("parent");
    fake.add("child");
    fake.parents.set("child", "parent");
    fake.report("child", true);
    fake.report("parent", true);
    await t.step(60_000);
    expect(states()).toEqual(["parent:sent"]);
    expect(t.transport.sent).toHaveLength(1);
  });

  it("a report for a session nobody owns pushes nothing and does not throw", () => {
    const { fake } = rig();
    expect(() => fake.report("ghost", true)).not.toThrow();
    expect(pushes()).toEqual([]);
  });

  it("stop() unsubscribes and forgets", () => {
    const { fake, source } = rig();
    fake.add("s1");
    source.stop();
    fake.report("s1", true);
    expect(pushes()).toEqual([]);
    expect(fake.listeners.size).toBe(0);
  });
});

describe("stillWaiting for a session ref: the feed's set and a live, unarchived row", () => {
  const event = (refId: string, ownerId = OWNER) => ({ refId, ownerId, cls: "approval" }) as EventRow;

  it("news about a session is not a question: it is never dropped for not waiting", () => {
    const { source } = rig();
    const news = { refId: "s9", ownerId: OWNER, cls: "failed" } as EventRow;
    expect(source.waiting(news)).toBe(true);
    expect(source.verdict(news)).toBe("waiting");
  });

  it("holds while the session waits and drops with the report", () => {
    const { fake, source } = rig();
    fake.add("s1");
    expect(source.waiting(event("s1"))).toBe(false);
    fake.report("s1", true);
    expect(source.waiting(event("s1"))).toBe(true);
    fake.report("s1", false);
    expect(source.waiting(event("s1"))).toBe(false);
  });

  it("a worker that died (no state, or no report yet) is no longer waiting: no push", async () => {
    const { fake } = rig();
    fake.add("s1");
    fake.report("s1", true);
    fake.states.delete("s1");
    await t.step(60_000);
    expect(t.transport.sent).toEqual([]);
    expect(t.bed.db.get("SELECT state, reason FROM push_events")).toEqual({
      state: "cancelled",
      reason: "gone",
    });
  });

  it("an archived session is not waiting", () => {
    const { fake, source } = rig();
    fake.add("s1");
    fake.report("s1", true);
    fake.states.set("s1", { archived: true, running: false, needsInput: false });
    expect(source.waiting(event("s1"))).toBe(false);
  });

  it("another owner's event never reads the session", () => {
    const { fake, source } = rig();
    fake.add("s1");
    fake.report("s1", true);
    expect(source.waiting(event("s1", "u2"))).toBe(false);
  });

  it("verdict: waiting while it waits, gone otherwise (a session never times out)", () => {
    const { fake, source } = rig();
    fake.add("s1");
    fake.report("s1", true);
    expect(source.verdict(event("s1"))).toBe("waiting");
    fake.report("s1", false);
    expect(source.verdict(event("s1"))).toBe("gone");
  });

  it("an empty set after a restart: nothing waits, a pending push cancels", async () => {
    const { fake } = rig();
    fake.add("s1");
    fake.report("s1", true);
    stop();
    const again = wireSessionSource({
      sessions: fakeSessions().sessions,
      notifier: t.notifier,
      logger: t.bed.logger,
    });
    t.state.waitingFor = (e) => again.waiting(e);
    await t.step(60_000);
    again.stop();
    expect(t.transport.sent).toEqual([]);
  });
});

describe("one waiting task session is one push, not two (M12-RT-02)", () => {
  function joined(order: "inbox-first" | "session-first") {
    t = openSendBed(["a"], [INBOX_MIGRATIONS]);
    const events = createAutomationEvents(t.bed.logger);
    const inbox = createInbox({
      db: t.bed.db,
      clock: t.bed.clock,
      logger: t.bed.logger,
      hub: createStreamHub(undefined, t.bed.clock),
      events,
      tasks: {
        find: () => ({
          ownerId: OWNER,
          triggerName: "Check disk",
          sessionId: "s-q",
          registeredName: "Check disk",
        }),
      },
      readOnly: false,
    });
    const { fake, sessions } = fakeSessions();
    fake.add("s-q");
    const attend = (needsInput: boolean) => {
      if (order === "session-first") fake.report("s-q", needsInput);
      events.emit({ kind: "attention", taskId: "q", sessionId: "s-q", needsInput });
      if (order === "inbox-first") fake.report("s-q", needsInput);
    };
    // Whichever source is wired first hears the report first, and creates the event.
    const sources: { stop(): void }[] = [];
    const wire = (which: "inbox" | "session") => {
      if (which === "inbox")
        sources.push(wireInboxSource({ inbox, notifier: t.notifier, logger: t.bed.logger }));
      else sources.push(wireSessionSource({ sessions, notifier: t.notifier, logger: t.bed.logger }));
    };
    wire(order === "inbox-first" ? "inbox" : "session");
    wire(order === "inbox-first" ? "session" : "inbox");
    stop = () => {
      for (const source of sources) source.stop();
      inbox.stop();
    };
    return { attend };
  }

  for (const order of ["inbox-first", "session-first"] as const)
    it(`the attention report and the Inbox item join one key (${order})`, async () => {
      const { attend } = joined(order);
      attend(true);
      expect(t.bed.db.all("SELECT dedup_key FROM push_events")).toEqual([
        { dedup_key: "push:approval:session:s-q" },
      ]);
      expect(t.bed.db.all("SELECT kind FROM outbox")).toEqual([{ kind: "push.send" }]);
      attend(false);
      expect(t.bed.db.all("SELECT state, reason FROM push_events")).toEqual([
        { state: "cancelled", reason: "answered" },
      ]);
    });
});

describe("what the push carries (RT-09)", () => {
  it("names only the registry name of the agent that owns the session, when the owner asked for names", async () => {
    const asked: string[] = [];
    const { fake, notified } = rig((ownerId, agentId) => {
      asked.push(`${ownerId}/${agentId}`);
      return "Atlas\u202e";
    });
    t.state.settings = NotificationsSettings.parse({ titles: "names" });
    fake.add("thread", OWNER, "atlas-1a2b");
    fake.add("plain");
    fake.report("thread", true);
    fake.report("plain", true);
    expect(asked).toEqual([`${OWNER}/atlas-1a2b`]);
    expect(notified[0]).toEqual({
      ownerId: OWNER,
      cls: "approval",
      refKind: "session",
      refId: "thread",
      name: "Atlas\u202e",
    });
    expect(notified[1]).toEqual({ ownerId: OWNER, cls: "approval", refKind: "session", refId: "plain" });
    await t.step(60_000);
    expect(wire(0).body).toContain("Atlas");
    expect(wire(0).body).not.toContain("\u202e");
    expect(wire(1).body).not.toContain("Atlas");
  });

  it("a failing name lookup is logged and the push stays generic", async () => {
    const { fake } = rig(() => {
      throw new Error("registry down");
    });
    fake.add("thread", OWNER, "atlas-1a2b");
    fake.report("thread", true);
    await t.step(60_000);
    expect(t.transport.sent).toHaveLength(1);
    expect(wire().body).not.toContain("registry down");
  });

  it("notify is given the session's id and class and nothing of its text", () => {
    const { fake, notified } = rig();
    fake.add("s1");
    fake.report("s1", true);
    expect(Object.keys(notified[0] ?? {}).sort()).toEqual(["cls", "ownerId", "refId", "refKind"]);
  });
});
