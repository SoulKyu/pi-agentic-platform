import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger, silentLogger } from "../../../kernel/logger.ts";
import { AUDIT_MIGRATIONS } from "../index.ts";

/** A real database through `migrate`, a fake clock at today's date and a logger that keeps its lines. */
export function createAuditBed() {
  const dir = mkdtempSync(join(tmpdir(), "pap-audit-"));
  const clock = createFakeClock(Date.now());
  const db: Db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    db,
    clock,
    logger,
    lines,
    /** Every later INSERT fails: the table is gone (its triggers with it). */
    failWrites: () => db.exec("DROP TABLE audit"),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
