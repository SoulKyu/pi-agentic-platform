import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { KERNEL_MIGRATIONS, type MigrationSource, migrate } from "../db/migrate.ts";
import { createLogger, type Logger } from "../logger.ts";

export interface OutboxBed {
  readonly db: Db;
  readonly clock: FakeClock;
  readonly logger: Logger;
  /** Every log entry written so far, parsed. */
  readonly logs: Array<Record<string, unknown>>;
  close(): void;
}

/** A real temporary SQLite with the kernel migrations (and `more`) applied, a fake clock and a logger that keeps its entries. */
export function openOutboxBed(more: readonly MigrationSource[] = []): OutboxBed {
  const dir = mkdtempSync(join(tmpdir(), "pap-outbox-"));
  const clock = createFakeClock();
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const { db } = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, ...more],
    clock,
    logger,
  });
  logs.length = 0;
  return {
    db,
    clock,
    logger,
    logs,
    close() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
