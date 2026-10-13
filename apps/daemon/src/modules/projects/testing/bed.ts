import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";
import { PROJECTS_MIGRATIONS } from "../index.ts";

/** A real database in a temp dir, a fake clock, and a logger that keeps its lines. */
export function createProjectsBed() {
  const dir = mkdtempSync(join(tmpdir(), "pap-projects-"));
  const clock = createFakeClock();
  const db: Db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, PROJECTS_MIGRATIONS],
    clock,
    logger: createLogger({ level: "error", clock, write: () => {} }),
  }).db;
  const lines: Array<Record<string, unknown>> = [];
  const logger: Logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  let counter = 0;
  const newId = () => `p${++counter}`;
  return {
    db,
    clock,
    logger,
    newId,
    lines,
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
