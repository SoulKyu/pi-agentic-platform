import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { openDatabase } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { NO_SCOPES } from "../../kernel/supervisor/scope.ts";
import { createStreamHub } from "../../kernel/ws/stream-hub.ts";
import { createSessionsModule, SESSIONS_MIGRATIONS } from "./index.ts";
import { createSessionsStore } from "./store.ts";
import { fakePolicyPort } from "./testing/fake-policy.ts";
import { fakeProjectsPort } from "./testing/fake-projects.ts";
import { captureLogger } from "./testing/helpers.ts";
import { testCaller } from "../../testing/caller.ts";
import { noAttachments } from "./testing/no-attachments.ts";

// The real supervisor forks a process; nothing here starts a worker, so it only has to exist.
vi.mock("../../kernel/supervisor/worker.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../kernel/supervisor/worker.ts")>()),
  spawnWorker: () => {
    throw new Error("no worker in a read-only test");
  },
}));

const DAY = 86_400_000;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-sessions-ro-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("sessions module over a read-only database (RT-04)", () => {
  it("boots, serves what is stored and does not backfill projects", async () => {
    const clock = createFakeClock();
    const dbPath = join(root, "s.db");
    const writable = migrate({
      dbPath,
      backupsDir: join(root, "b"),
      sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
      clock,
      logger: silentLogger,
    }).db;
    createSessionsStore(writable).insert({
      id: "s1",
      piPath: null,
      piSessionId: null,
      cwd: "/w/a",
      ownerId: "u1",
      name: null,
      createdAt: clock.now() - 5 * DAY,
      updatedAt: clock.now() - 4 * DAY,
    });
    writable.close();
    const db = openDatabase(dbPath, { readOnly: true });
    try {
      mkdirSync(join(root, "pap"));
      const { logger, lines } = captureLogger();
      const projects = fakeProjectsPort();
      const sessions = createSessionsModule({
        db,
        clock,
        logger,
        hub: createStreamHub(),
        policy: fakePolicyPort(),
        projects,
        ownerId: () => "u1",
        audit: { append: () => {}, reserve: () => true, fromWorker: () => null },
        attachments: noAttachments,
        config: {
          home: join(root, "pap"),
          piAgentDir: join(root, "agent"),
          piHostEntry: "/pi-host/main.ts",
          piHostExecArgv: [],
          testProviderScript: null,
          maxWorkers: 2,
          minFreeMemMb: 0,
          workerIdleMs: 0,
        },
        workerUmask: 0o022,
        env: {},
        scopes: NO_SCOPES,
      });
      await clock.advance(0);
      expect(clock.pending()).toBe(0);
      expect(createSessionsStore(db).marks.row("s1")?.marks.settledAt).toBeNull();
      expect(projects.ensured).toEqual([]);
      expect(createSessionsStore(db).marks.row("s1")?.projectId).toBeNull();
      expect(lines.filter((line) => line["msg"] === "session_projects_backfill_failed")).toEqual([]);
      const ctx = {
        caller: testCaller(),
        connectionId: "c1",
        openSubscription: () => "x",
        closeSubscription: () => {},
      };
      expect(await sessions.rpc["sessions.list"]({}, ctx)).toEqual({
        sessions: [expect.objectContaining({ id: "s1" })],
      });
    } finally {
      db.close();
    }
  });
});
