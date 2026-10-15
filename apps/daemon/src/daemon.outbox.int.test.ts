import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "./kernel/db/database.ts";
import { httpRequest } from "./testing/http-client.ts";
import { startTestDaemon } from "./testing/harness.ts";

const ANSWER = { steps: [{ text: "a scripted answer" }] };

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pap-outbox-int-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Boots and stops a daemon on `home`, so its database exists and `edit` can write to it between lives. */
async function bootAndStop(): Promise<void> {
  const test = await startTestDaemon(ANSWER, { config: { home } });
  expect((await httpRequest(`${test.base}/healthz`)).status).toBe(200);
  await test.stop();
}

function withDb<T>(work: (db: ReturnType<typeof openDatabase>) => T): T {
  const db = openDatabase(join(home, "state.db"));
  try {
    return work(db);
  } finally {
    db.close();
  }
}

const seedLeased = (kind: string, replay: string) =>
  withDb((db) =>
    db.run(
      `INSERT INTO outbox (kind, replay, payload, status, next_at, lease_until, created_at)
       VALUES ($kind, $replay, '{}', 'leased', 0, 9, 0)`,
      { kind, replay },
    ),
  );
const statuses = () =>
  withDb((db) => db.all<{ kind: string; status: string }>("SELECT kind, status FROM outbox ORDER BY id"));

describe("the outbox at boot", () => {
  it("boots and stops with the outbox, recovering the previous life before it serves", async () => {
    await bootAndStop();
    seedLeased("task.start", "process-bound");
    // A kind no handler claims (M9's lane effects live in M9's rows): recovery requeues it and the worker leaves it pending.
    seedLeased("lane.setup", "replay-safe");

    const test = await startTestDaemon(ANSWER, { config: { home } });
    expect((await httpRequest(`${test.base}/healthz`)).status).toBe(200);
    await test.stop();

    expect(statuses()).toEqual([
      { kind: "task.start", status: "retired" },
      { kind: "lane.setup", status: "pending" },
    ]);
  });

  it("boots on a database written by a newer pap and recovers nothing", async () => {
    await bootAndStop();
    seedLeased("task.start", "process-bound");
    withDb((db) =>
      db.run(
        "INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('future/202699990000_x.sql', 'x', 0)",
      ),
    );

    const test = await startTestDaemon(ANSWER, { config: { home } });
    expect((await httpRequest(`${test.base}/healthz`)).status).toBe(200);
    await test.stop();

    expect(statuses()).toEqual([{ kind: "task.start", status: "leased" }]);
  });
});
