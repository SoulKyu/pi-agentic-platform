import { afterEach, describe, expect, it, vi } from "vitest";
import { createOutbox } from "../../kernel/outbox/index.ts";
import type { SessionsAutomationPort } from "../sessions/index.ts";
import { createHousekeeping } from "./housekeeping.ts";
import { createTaskStore } from "./tasks.ts";
import { createAutomationBed, type AutomationBed, manualInput, webhookInput } from "./testing/bed.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

let bed: AutomationBed;
afterEach(() => bed.dispose());

type Port = Pick<SessionsAutomationPort, "state" | "lastActivityAt" | "deleteTaskSession">;

function setup(options: { readOnly?: boolean; timeZone?: string | null } = {}) {
  bed = createAutomationBed();
  const store = createTaskStore(bed.db);
  const outbox = createOutbox({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    readOnly: options.readOnly ?? false,
  });
  const purge = vi.spyOn(outbox, "purge");
  const poke = vi.spyOn(outbox, "poke");
  /** When each session was last touched: the end of its task, unless a test says otherwise. */
  const activity = new Map<string, number>();
  const sessions = {
    state: vi.fn<Port["state"]>(() => ({ archived: true, running: false, needsInput: false })),
    lastActivityAt: vi.fn<Port["lastActivityAt"]>((sessionId) => activity.get(sessionId) ?? null),
    deleteTaskSession: vi.fn<Port["deleteTaskSession"]>(() => "deleted"),
  };
  const inboxRetention = vi.fn();
  const housekeeping = createHousekeeping({
    db: bed.db,
    clock: bed.clock,
    logger: bed.logger,
    store,
    outbox,
    sessions,
    inboxRetention,
    timeZone: () => options.timeZone ?? "UTC",
    readOnly: options.readOnly ?? false,
  });
  let ids = 0;
  /** A finished task that ended `ageDays` ago; its session's last activity is its end unless told otherwise. */
  const finished = (state: "done" | "failed", ageDays: number, sessionId: string | null = `s${ids + 1}`) => {
    const id = `t${++ids}`;
    store.insert({
      id,
      ownerId: "u1",
      triggerId: null,
      origin: "manual",
      cwd: bed.folder,
      prompt: "p",
      tainted: false,
      gated: true,
      policy: { mode: "supervised", tools: ["read"], preset: "read-only", env: [] },
      title: "Nightly check",
      detail: null,
      retryOf: null,
      retryOnInterrupt: false,
      maxRunMs: 60_000,
      maxRunUsd: null,
      at: bed.clock.now() - ageDays * DAY - 1_000,
    });
    const endedAt = bed.clock.now() - ageDays * DAY;
    bed.db.run(
      "UPDATE tasks SET state = $state, ended_at = $endedAt, session_id = $sessionId WHERE id = $id",
      { id, state, endedAt, sessionId },
    );
    if (sessionId !== null) activity.set(sessionId, endedAt);
    return { id, sessionId, endedAt };
  };
  const queued = (ageDays: number): string => {
    const old = finished("failed", ageDays, null);
    bed.db.run("DROP TRIGGER tasks_terminal_immutable");
    bed.db.run("UPDATE tasks SET state = 'queued', ended_at = NULL WHERE id = $id", { id: old.id });
    return old.id;
  };
  const taskIds = () => bed.db.all<{ id: string }>("SELECT id FROM tasks ORDER BY id").map((row) => row.id);
  return { housekeeping, store, outbox, purge, poke, sessions, inboxRetention, finished, queued, taskIds };
}

describe("the hourly pass (M10R44)", () => {
  it("purges the outbox, calls the Inbox retention and enqueues today's cleanup once", () => {
    const { housekeeping, purge, inboxRetention, poke } = setup();
    housekeeping.pass();
    expect(purge).toHaveBeenCalledTimes(1);
    expect(inboxRetention).toHaveBeenCalledTimes(1);
    const effects = () =>
      bed.db.all<{ kind: string; owner_id: string | null; dedup_key: string; payload: string }>(
        "SELECT kind, owner_id, dedup_key, payload FROM outbox WHERE kind = 'attachment.cleanup'",
      );
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(bed.clock.now());
    expect(effects()).toEqual([
      {
        kind: "attachment.cleanup",
        owner_id: null,
        dedup_key: `attachments:${day}`,
        payload: JSON.stringify({ day }),
      },
    ]);
    expect(poke).toHaveBeenCalledTimes(1);
    housekeeping.pass();
    expect(effects()).toHaveLength(1);
  });

  it("names the day in the automation time zone, and enqueues again the next day", async () => {
    const { housekeeping } = setup({ timeZone: "Pacific/Kiritimati" });
    const key = () =>
      bed.db.all<{ dedup_key: string }>(
        "SELECT dedup_key FROM outbox WHERE kind = 'attachment.cleanup' ORDER BY id",
      );
    housekeeping.pass();
    const first = key()[0]?.dedup_key as string;
    expect(first).toBe(
      `attachments:${new Intl.DateTimeFormat("en-CA", { timeZone: "Pacific/Kiritimati" }).format(bed.clock.now())}`,
    );
    await bed.clock.advance(DAY);
    housekeeping.pass();
    expect(key()).toHaveLength(2);
    expect(key()[1]?.dedup_key).not.toBe(first);
  });

  it("goes on with the other steps when one fails, and says so", () => {
    const { housekeeping, purge, inboxRetention, finished, taskIds } = setup();
    purge.mockImplementation(() => {
      throw new Error("purge broken");
    });
    finished("failed", 31, null);
    housekeeping.pass();
    expect(inboxRetention).toHaveBeenCalledTimes(1);
    expect(taskIds()).toEqual([]);
    expect(bed.logs.some((line) => line.msg === "housekeeping_outbox_purge_failed")).toBe(true);
  });
});

describe("old tasks (M10R44)", () => {
  it("deletes terminal tasks ended more than 30 days ago, whatever their state, and keeps newer and live ones", () => {
    const { housekeeping, finished, queued, taskIds } = setup();
    const old = finished("failed", 31, null);
    const oldDone = finished("done", 31, null);
    const young = finished("failed", 29, null);
    const waiting = queued(40);
    housekeeping.pass();
    expect(taskIds()).toEqual([young.id, waiting].sort());
    expect(taskIds()).not.toContain(old.id);
    expect(taskIds()).not.toContain(oldDone.id);
  });
});

describe("done task sessions (M10R155)", () => {
  it("deletes the session of a done task untouched for 30 days, then the task row", () => {
    const { housekeeping, sessions, finished, taskIds } = setup();
    const task = finished("done", 31);
    sessions.lastActivityAt.mockReturnValue(task.endedAt + 60_000);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).toHaveBeenCalledTimes(1);
    expect(sessions.deleteTaskSession).toHaveBeenCalledWith("u1", task.sessionId);
    expect(taskIds()).toEqual([]);
  });

  it("keeps a session the owner went back to (activity later than the end plus 60 s), and drops the task row", () => {
    const { housekeeping, sessions, finished, taskIds } = setup();
    const task = finished("done", 31);
    sessions.lastActivityAt.mockReturnValue(task.endedAt + 60_001);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).not.toHaveBeenCalled();
    expect(taskIds()).toEqual([]);
  });

  it("keeps a session that was taken out of the archive, and never deletes a younger one", () => {
    const { housekeeping, sessions, finished } = setup();
    finished("done", 31);
    sessions.state.mockReturnValue({ archived: false, running: false, needsInput: false });
    housekeeping.pass();
    finished("done", 29);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).not.toHaveBeenCalled();
  });

  it("keeps the session and the task when the session is busy, and tries again at the next pass", () => {
    const { housekeeping, sessions, finished, taskIds } = setup();
    const task = finished("done", 31);
    sessions.deleteTaskSession.mockReturnValueOnce("busy");
    housekeeping.pass();
    expect(taskIds()).toEqual([task.id]);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).toHaveBeenCalledTimes(2);
    expect(taskIds()).toEqual([]);
  });

  it("drops the task row of a session that is already gone", () => {
    const { housekeeping, sessions, finished, taskIds } = setup();
    finished("done", 31);
    sessions.state.mockReturnValue(null);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).not.toHaveBeenCalled();
    expect(taskIds()).toEqual([]);
  });

  it("deletes 100 sessions a pass out of 150", () => {
    const { housekeeping, sessions, finished, taskIds } = setup();
    for (let n = 0; n < 150; n += 1) finished("done", 31 + n / 1_000);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).toHaveBeenCalledTimes(100);
    expect(taskIds()).toHaveLength(50);
    housekeeping.pass();
    expect(sessions.deleteTaskSession).toHaveBeenCalledTimes(150);
    expect(taskIds()).toEqual([]);
  });

  it("asks the session's own owner, and never touches a task that has no session", () => {
    const { housekeeping, sessions, finished } = setup();
    finished("done", 31, null);
    bed.db.run("UPDATE tasks SET owner_id = 'u2' WHERE session_id IS NULL");
    const other = finished("done", 31);
    bed.db.run("UPDATE tasks SET owner_id = 'u2' WHERE id = $id", { id: other.id });
    housekeeping.pass();
    expect(sessions.deleteTaskSession).toHaveBeenCalledTimes(1);
    expect(sessions.deleteTaskSession).toHaveBeenCalledWith("u2", other.sessionId);
  });
});

describe("the journal cut (M10R44, RT-17)", () => {
  const insertFires = (
    triggerId: string,
    rows: Array<{ verdict: string; lastAt: number; detail?: string }>,
  ) => {
    for (const row of rows)
      bed.db.run(
        `INSERT INTO trigger_fires (trigger_id, owner_id, source, verdict, detail, count, first_at, last_at)
         VALUES ($triggerId, 'u1', 'webhook', $verdict, $detail, 1, $lastAt, $lastAt)`,
        { triggerId, verdict: row.verdict, detail: row.detail ?? null, lastAt: row.lastAt },
      );
  };
  const left = (triggerId: string) =>
    bed.db.get<{ n: number }>("SELECT count(*) AS n FROM trigger_fires WHERE trigger_id = $triggerId", {
      triggerId,
    })?.n;

  it("keeps the newest 500 rows per trigger and every fired row inside the trigger's dedup window", () => {
    const { housekeeping } = setup();
    const hook = bed.triggers.create(bed.owner(), webhookInput(bed.folder)).trigger;
    const other = bed.triggers.create(bed.owner(), manualInput(bed.folder, "Other")).trigger;
    const now = bed.clock.now();
    insertFires(hook.id, [
      // The default window is 10 minutes: the first is inside it, the second is not.
      { verdict: "fired", lastAt: now - 5 * 60_000 },
      { verdict: "fired", lastAt: now - 30 * 60_000 },
      ...Array.from({ length: 600 }, (_, n) => ({ verdict: "error", lastAt: now, detail: `d${n}` })),
    ]);
    insertFires(other.id, [{ verdict: "error", lastAt: now }]);
    housekeeping.pass();
    expect(left(hook.id)).toBe(501);
    expect(left(other.id)).toBe(1);
    const kept = bed.db.all<{ verdict: string; last_at: number }>(
      "SELECT verdict, last_at FROM trigger_fires WHERE trigger_id = $id AND verdict = 'fired'",
      { id: hook.id },
    );
    expect(kept).toEqual([{ verdict: "fired", last_at: now - 5 * 60_000 }]);
  });

  it("does not cut a trigger at 500 rows or fewer", () => {
    const { housekeeping } = setup();
    const hook = bed.triggers.create(bed.owner(), webhookInput(bed.folder)).trigger;
    insertFires(
      hook.id,
      Array.from({ length: 500 }, (_, n) => ({ verdict: "error", lastAt: bed.clock.now(), detail: `d${n}` })),
    );
    housekeeping.pass();
    expect(left(hook.id)).toBe(500);
  });
});

describe("the timer", () => {
  it("runs a pass each hour on the clock, re-arms after a failing pass, and stops clean", async () => {
    const { housekeeping, purge } = setup();
    housekeeping.start();
    expect(bed.clock.pending()).toBe(1);
    await bed.clock.advance(HOUR - 1);
    expect(purge).not.toHaveBeenCalled();
    purge.mockImplementationOnce(() => {
      throw new Error("boom");
    });
    await bed.clock.advance(1);
    expect(purge).toHaveBeenCalledTimes(1);
    await bed.clock.advance(HOUR);
    expect(purge).toHaveBeenCalledTimes(2);
    housekeeping.stop();
    expect(bed.clock.pending()).toBe(0);
  });

  it("arms nothing and writes nothing in read-only mode", async () => {
    const { housekeeping, purge, finished, taskIds } = setup({ readOnly: true });
    finished("failed", 40, null);
    housekeeping.start();
    expect(bed.clock.pending()).toBe(0);
    housekeeping.pass();
    expect(purge).not.toHaveBeenCalled();
    expect(taskIds()).toHaveLength(1);
  });
});
