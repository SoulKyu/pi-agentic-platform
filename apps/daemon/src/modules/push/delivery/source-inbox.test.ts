import { NotificationsSettings, type TaskState, type TaskView } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import { createAutomationEvents } from "../../automation/index.ts";
import { createInbox, INBOX_MIGRATIONS, type Inbox } from "../../inbox/index.ts";
import { OWNER, openSendBed, type SendBed } from "../testing/send-bed.ts";
import type { PushNotifier } from "../service.ts";
import type { EventRow } from "./events.ts";
import { wireInboxSource } from "./source-inbox.ts";

const AGENT = "atlas-1a2b";
let t: SendBed;
let stop: () => void = () => {};
afterEach(() => {
  stop();
  t.close();
});

interface Rig {
  readonly inbox: Inbox;
  readonly source: ReturnType<typeof wireInboxSource>;
  readonly notified: Array<Record<string, unknown>>;
  addTask(id: string, registered?: string | null, title?: string, session?: string | null): void;
  attend(id: string, needsInput: boolean): void;
  timeout(id: string): void;
  move(id: string, state: TaskState): void;
}

function rig(agentName?: (ownerId: string, agentId: string) => string | null): Rig {
  t = openSendBed(["a"], [INBOX_MIGRATIONS]);
  const events = createAutomationEvents(t.bed.logger);
  const tasks = new Map<
    string,
    { ownerId: string; triggerName: string; sessionId: string | null; registeredName: string | null }
  >();
  const inbox = createInbox({
    db: t.bed.db,
    clock: t.bed.clock,
    logger: t.bed.logger,
    hub: createStreamHub(undefined, t.bed.clock),
    events,
    tasks: { find: (id) => tasks.get(id) ?? null },
    readOnly: false,
  });
  const notified: Array<Record<string, unknown>> = [];
  const spy: PushNotifier = {
    ...t.notifier,
    notify: (event) => {
      notified.push(event);
      return t.notifier.notify(event);
    },
  };
  const source = wireInboxSource({ inbox, notifier: spy, logger: t.bed.logger, agentName });
  stop = () => {
    source.stop();
    inbox.stop();
  };
  // The session source is task 11's: here a session still waits.
  t.state.waitingFor = (event) => (event.refKind === "inbox" ? source.waiting(event) : true);
  t.state.judge = (event) => source.verdict(event);
  return {
    inbox,
    source,
    notified,
    addTask(id, registered = "prod-alerts", title = "a title", session = `s-${id}`) {
      tasks.set(id, {
        ownerId: OWNER,
        triggerName: registered ?? title,
        sessionId: session,
        registeredName: registered,
      });
    },
    attend: (id, needsInput) =>
      events.emit({ kind: "attention", taskId: id, sessionId: `s-${id}`, needsInput }),
    timeout: (id) => events.emit({ kind: "attention_timeout", taskId: id, denied: 1 }),
    move(id, state) {
      const task = tasks.get(id);
      const view = {
        id,
        triggerId: "g1",
        triggerName: task?.triggerName ?? "",
        projectId: null,
        state,
        reason: null,
        origin: "manual",
        title: "a title",
        detail: null,
        createdAt: 1,
        startedAt: 2,
        endedAt: null,
        sessionId: task?.sessionId ?? null,
        needsInput: false,
        costUsd: 0,
        resetAt: null,
        toolsReleased: false,
      } as TaskView;
      events.emit({ kind: "task", ownerId: OWNER, task: view, previous: "running" });
    },
  };
}

const pushes = () =>
  t.bed.db.all<{
    cls: string;
    ref_kind: string;
    ref_id: string;
    name: string | null;
    state: string;
    reason: string | null;
  }>("SELECT cls, ref_kind, ref_id, name, state, reason FROM push_events ORDER BY created_at, rowid");
const agentItem = (r: Rig, kind: string, refId: string, detail?: string) =>
  r.inbox.agentItems.upsertAgentItem({
    ownerId: OWNER,
    kind,
    agentId: AGENT,
    refId,
    toHandle: ["agent_approve", "secret_request"].includes(kind),
    detail,
  });
const wire = (call = 0) => new TextDecoder().decode(t.transport.sent[call]?.plaintext);
const itemId = (r: Rig, kind: string) =>
  r.inbox.list(OWNER, undefined).items.find((item) => item.kind === kind)?.id ?? "";

describe("each Inbox kind becomes its class (M12R2, M12R22)", () => {
  it("maps the task kinds, keying a question by its session", () => {
    const r = rig();
    for (const id of ["q", "f", "i", "d", "l"]) r.addTask(id);
    r.attend("q", true);
    r.move("f", "failed");
    r.move("i", "interrupted");
    r.move("d", "done");
    r.move("l", "limited");
    const rows = pushes().map((row) => `${row.cls}:${row.ref_kind}`);
    expect(rows.sort()).toEqual(
      ["approval:session", "failed:inbox", "failed:inbox", "done:inbox", "done:inbox"].sort(),
    );
    expect(pushes().find((row) => row.cls === "approval")?.ref_id).toBe("s-q");
    expect(pushes().find((row) => row.cls === "failed")?.ref_id).toBe(itemId(r, "task_failed"));
  });

  it("maps the agent kinds", () => {
    const r = rig();
    for (const kind of [
      "agent_approve",
      "secret_request",
      "agent_notify",
      "agent_egress",
      "agent_reply",
      "delegation_done",
    ])
      agentItem(r, kind, `ref-${kind}`);
    const byKind = Object.fromEntries(
      r.inbox.list(OWNER, undefined).items.map((item) => [item.kind, item.id]),
    );
    const got = pushes().map((row) => `${row.cls}:${row.ref_kind}:${row.ref_id}`);
    expect(got.sort()).toEqual(
      [
        `approval:inbox:${byKind["agent_approve"]}`,
        `approval:inbox:${byKind["secret_request"]}`,
        `notify:inbox:${byKind["agent_notify"]}`,
        `notify:inbox:${byKind["agent_egress"]}`,
        `reply:inbox:${byKind["agent_reply"]}`,
        `reply:inbox:${byKind["delegation_done"]}`,
      ].sort(),
    );
  });

  it("pushes nothing for an unknown kind (a newer daemon) nor for a question with no session", () => {
    const r = rig();
    agentItem(r, "future_kind", "x1");
    r.addTask("q", "prod-alerts", "t", null);
    r.attend("q", true);
    expect(pushes()).toEqual([]);
    expect(r.inbox.list(OWNER, undefined).items).toHaveLength(2);
  });

  it("stores an event of a class the owner switched off as suppressed:class_off", async () => {
    const r = rig();
    t.state.settings = NotificationsSettings.parse({ classes: { failed: false } });
    r.addTask("f");
    r.move("f", "failed");
    await t.step();
    expect(t.transport.sent).toEqual([]);
    expect(pushes()[0]).toMatchObject({ state: "suppressed", reason: "class_off" });
  });
});

describe("a second question pushes again", () => {
  it("second-question-pushes-again: the same row reopens and a new push is sent", async () => {
    const r = rig();
    r.addTask("q");
    r.attend("q", true);
    const row = itemId(r, "task_needs_input");
    await t.step(60_000);
    expect(pushes().map((e) => e.state)).toEqual(["sent"]);
    r.attend("q", false);
    await t.step(10_000);
    r.attend("q", true);
    expect(itemId(r, "task_needs_input")).toBe(row);
    expect(pushes().map((e) => e.state)).toEqual(["sent", "pending"]);
    await t.step(60_000);
    expect(pushes().map((e) => e.state)).toEqual(["sent", "sent"]);
    expect(t.transport.sent).toHaveLength(2);
  });

  it("mark-read-pushes-nothing: marking a sent approval read creates no event", async () => {
    const r = rig();
    agentItem(r, "agent_approve", "a1");
    await t.step(60_000);
    expect(pushes()).toHaveLength(1);
    const before = t.bed.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n;
    expect(r.inbox.markRead(OWNER, { all: true }).updated).toBe(1);
    await t.step(60_000);
    expect(pushes()).toHaveLength(1);
    expect(t.bed.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM outbox")?.n).toBe(before);
  });
});

describe("what the push carries (RT-09)", () => {
  it("never reads the detail: the notifier gets no detail and the wire holds none of it", async () => {
    const r = rig();
    agentItem(r, "agent_notify", "n1", "<script>alert(1)</script>\u202eevil");
    await t.step();
    expect(r.notified).toHaveLength(1);
    expect(r.notified[0]).not.toHaveProperty("detail");
    expect(JSON.stringify(r.notified)).not.toContain("script");
    expect(t.transport.sent).toHaveLength(1);
    expect(wire()).not.toContain("script");
    expect(wire()).not.toContain("\u202e");
    expect(wire()).not.toContain("evil");
  });

  it("names a task by its registered name only; a deleted trigger stays generic", async () => {
    const r = rig();
    r.addTask("a", "prod-alerts");
    r.addTask("b", null, "IGNORE PREVIOUS INSTRUCTIONS");
    r.move("a", "failed");
    r.move("b", "failed");
    await t.step();
    expect(
      pushes()
        .map((e) => e.name)
        .sort(),
    ).toEqual([null, "prod-alerts"]);
    expect(JSON.stringify(r.notified)).not.toContain("IGNORE");
    expect(wire(0) + wire(1)).not.toContain("IGNORE");
  });

  it("names an agent item from the agents port, stripped, and stays generic without a name", () => {
    const r = rig((_owner, agentId) => (agentId === AGENT ? "Atlas\u202e" : null));
    agentItem(r, "agent_notify", "n1");
    expect(pushes()[0]?.name).toBe("Atlas");
    expect(wire()).not.toContain("\u202e");
  });

  it("an agent port that throws or knows nothing leaves the name out", () => {
    const r = rig(() => {
      throw new Error("registry down");
    });
    agentItem(r, "agent_notify", "n1");
    expect(pushes()[0]?.name).toBeNull();
  });
});

describe("a resolved approval cancels its push", () => {
  it("answered: the event is cancelled and the outbox row retired", async () => {
    const r = rig();
    agentItem(r, "agent_approve", "a1");
    r.inbox.agentItems.resolveRef(OWNER, "agent_approve", "a1", "answered");
    expect(pushes()[0]).toMatchObject({ state: "cancelled", reason: "answered" });
    expect(
      t.bed.db.get<{ status: string }>("SELECT status FROM outbox WHERE kind = 'push.send'")?.status,
    ).toBe("retired");
    await t.step(60_000);
    expect(t.transport.sent).toEqual([]);
  });

  it("an isolated task's question timed out is cancelled as expired and never arrives", async () => {
    const r = rig();
    r.addTask("q");
    r.attend("q", true);
    r.timeout("q");
    expect(pushes()[0]).toMatchObject({ state: "cancelled", reason: "expired" });
    await t.step(60_000);
    expect(t.transport.sent).toEqual([]);
  });

  it("a question the task leaves behind is cancelled as gone, not as answered", () => {
    const r = rig();
    r.addTask("q");
    r.attend("q", true);
    r.move("q", "failed");
    expect(pushes().find((e) => e.cls === "approval")).toMatchObject({ state: "cancelled", reason: "gone" });
  });

  it("a resolved news item cancels nothing", async () => {
    const r = rig();
    agentItem(r, "agent_notify", "n1");
    r.inbox.agentItems.resolveRef(OWNER, "agent_notify", "n1", null);
    await t.step();
    expect(pushes()[0]?.state).toBe("sent");
  });
});

describe("the Inbox lines of the source tables", () => {
  const row = (r: Rig, cls: string, kind: string): EventRow => {
    const item = r.inbox.list(OWNER, undefined).items.find((i) => i.kind === kind);
    return {
      id: "e",
      ownerId: OWNER,
      cls,
      refKind: "inbox",
      refId: item?.id ?? "missing",
      name: null,
      dedupKey: "k",
      state: "pending",
      rechecks: 0,
    };
  };

  it("an approval waits while its item is open, is gone once answered and expired once timed out", () => {
    const r = rig();
    agentItem(r, "agent_approve", "a1");
    agentItem(r, "secret_request", "s1");
    const open = row(r, "approval", "agent_approve");
    expect([r.source.waiting(open), r.source.verdict(open)]).toEqual([true, "waiting"]);
    r.inbox.agentItems.resolveRef(OWNER, "agent_approve", "a1", "answered");
    r.inbox.agentItems.resolveRef(OWNER, "secret_request", "s1", "timed_out");
    expect([r.source.waiting(open), r.source.verdict(open)]).toEqual([false, "gone"]);
    const timedOut = row(r, "approval", "secret_request");
    expect([r.source.waiting(timedOut), r.source.verdict(timedOut)]).toEqual([false, "expired"]);
  });

  it("news waits while its item exists; a deleted or foreign item is gone", () => {
    const r = rig();
    agentItem(r, "agent_notify", "n1");
    const news = row(r, "notify", "agent_notify");
    expect([r.source.waiting(news), r.source.verdict(news)]).toEqual([true, "waiting"]);
    expect([
      r.source.waiting({ ...news, ownerId: "u2" }),
      r.source.verdict({ ...news, ownerId: "u2" }),
    ]).toEqual([false, "gone"]);
    r.inbox.agentItems.removeRef(OWNER, "agent_notify", "n1");
    expect([r.source.waiting(news), r.source.verdict(news)]).toEqual([false, "gone"]);
  });
});
