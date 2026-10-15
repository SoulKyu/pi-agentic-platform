import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";
import { RUNS_MIGRATIONS } from "../index.ts";

export interface RunsBed {
  readonly dir: string;
  readonly db: Db;
  readonly clock: FakeClock;
  readonly logger: Logger;
  /** Every warning or error written so far, parsed. */
  readonly logs: Array<Record<string, unknown>>;
  close(): void;
}

/** A real temporary SQLite with the kernel and runs migrations, a fake clock and a logger that keeps its entries. */
export function openRunsBed(): RunsBed {
  const dir = mkdtempSync(join(tmpdir(), "pap-runs-"));
  const clock = createFakeClock(Date.UTC(2026, 9, 14, 12, 0, 0));
  const logs: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "warn",
    clock,
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const { db } = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, RUNS_MIGRATIONS],
    clock,
    logger,
  });
  logs.length = 0;
  return {
    dir,
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
