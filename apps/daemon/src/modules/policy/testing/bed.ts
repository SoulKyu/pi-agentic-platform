import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";
import { POLICY_MIGRATIONS } from "../index.ts";

export const KEY = "a".repeat(64);

/** Grant keys are 64 hex characters; `n` makes distinct ones. */
export const keyOf = (n: number): string => n.toString(16).padStart(64, "0");

/** A real database in a temp dir, a fake clock that moves one millisecond per rule, and a logger that keeps its lines. */
export function createPolicyBed() {
  const dir = mkdtempSync(join(tmpdir(), "pap-policy-"));
  const clock = createFakeClock();
  const db: Db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, POLICY_MIGRATIONS],
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
  const newId = () => `r${++counter}`;
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
