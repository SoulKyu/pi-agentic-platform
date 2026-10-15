import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventFrame, type TaskState, type TaskView } from "@pap/contracts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger } from "../../../kernel/logger.ts";
import { createStreamHub } from "../../../kernel/ws/stream-hub.ts";
import { createAutomationEvents } from "../../automation/index.ts";
import { createInbox, INBOX_MIGRATIONS } from "../index.ts";

export const DAY_MS = 86_400_000;

interface BedTask {
  readonly ownerId: string;
  readonly triggerName: string;
  readonly sessionId: string | null;
}

/** A real database through `migrate`, a fake clock and hub, and the Inbox listening to a real `AutomationEvents`. */
export function createInboxBed(options: { readOnly?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pap-inbox-"));
  const clock = createFakeClock(Date.UTC(2026, 9, 14));
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, INBOX_MIGRATIONS],
    clock,
    logger,
  }).db;
  logs.length = 0;
  const events = createAutomationEvents(logger);
  const hub = createStreamHub(undefined, clock);
  const tasks = new Map<string, BedTask>();
  const inbox = createInbox({
    db,
    clock,
    logger,
    hub,
    events,
    tasks: { find: (taskId) => tasks.get(taskId) ?? null },
    readOnly: options.readOnly ?? false,
  });
  const frames = new Map<string, EventFrame[]>();
  let opened = 0;
  const bed = {
    db,
    clock,
    logs,
    logger,
    events,
    hub,
    inbox,
    /** A task the bed knows (the automation module's `taskInfo`). */
    addTask(
      taskId: string,
      ownerId = "u1",
      triggerName = "prod-alerts",
      sessionId: string | null = `s-${taskId}`,
    ) {
      tasks.set(taskId, { ownerId, triggerName, sessionId });
    },
    attend: (taskId: string, needsInput: boolean) =>
      events.emit({ kind: "attention", taskId, sessionId: `s-${taskId}`, needsInput }),
    timeout: (taskId: string) => events.emit({ kind: "attention_timeout", taskId, denied: 1 }),
    /** The runner moved a task: the event it emits, carrying the task as the board shows it. */
    move(taskId: string, state: TaskState, previous: TaskState | null = "running", costUsd = 0) {
      const task = tasks.get(taskId) as BedTask;
      const view: TaskView = {
        id: taskId,
        triggerId: "g1",
        triggerName: task.triggerName,
        projectId: null,
        state,
        reason: null,
        origin: "manual",
        title: "a title",
        detail: null,
        createdAt: 1,
        startedAt: 2,
        endedAt: null,
        sessionId: task.sessionId,
        needsInput: false,
        costUsd,
        resetAt: null,
        toolsReleased: false,
      };
      events.emit({ kind: "task", ownerId: task.ownerId, task: view, previous });
    },
    /** What the owner's open Inbox received so far (the snapshot is the first frame). */
    open(ownerId: string): EventFrame[] {
      const list: EventFrame[] = [];
      frames.set(ownerId, list);
      hub.open({
        connectionId: `c${++opened}`,
        sub: `sub${opened}`,
        stream: "inbox",
        key: ownerId,
        after: undefined,
        send: (frame) => void list.push(frame),
      });
      return list;
    },
    rows: () =>
      db.all<Record<string, unknown>>("SELECT * FROM inbox_items ORDER BY created_at, id").map((row) => row),
    row: (taskId: string, kind: string) =>
      db.get<Record<string, unknown>>("SELECT * FROM inbox_items WHERE task_id = $taskId AND kind = $kind", {
        taskId,
        kind,
      }),
    /** Rows written straight into the table, as many as a cap test needs. */
    seed(
      ownerId: string,
      count: number,
      row: { kind: string; toHandle?: boolean; read?: boolean; at?: number },
    ) {
      db.transaction(() => {
        for (let index = 0; index < count; index += 1)
          db.run(
            `INSERT INTO inbox_items (id, owner_id, kind, to_handle, title, created_at, read_at)
             VALUES ($id, $ownerId, $kind, $toHandle, 'seed', $at, $readAt)`,
            {
              id: `seed-${ownerId}-${row.kind}-${row.read ? "r" : "u"}-${row.at ?? 0}-${index}`,
              ownerId,
              kind: row.kind,
              toHandle: row.toHandle ? 1 : 0,
              at: (row.at ?? 100) + index,
              readAt: row.read ? (row.at ?? 100) + index : null,
            },
          );
      });
    },
    dispose() {
      inbox.stop();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return bed;
}
export type InboxBed = ReturnType<typeof createInboxBed>;
