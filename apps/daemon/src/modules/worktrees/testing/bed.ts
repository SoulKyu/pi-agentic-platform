import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";
import { LANES_MIGRATIONS } from "../../lanes/index.ts";
import { WORKTREES_MIGRATIONS } from "../index.ts";

export const OID = "a".repeat(40);

/** A real database in a temp dir, a fake clock, a pap home, and a logger that keeps its lines. */
export function createWorktreesBed() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-worktrees-")));
  const papHome = join(dir, "pap");
  mkdirSync(papHome);
  const clock = createFakeClock();
  const db: Db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, WORKTREES_MIGRATIONS, LANES_MIGRATIONS],
    clock,
    logger: createLogger({ level: "error", clock, write: () => {} }),
  }).db;
  const lines: Array<Record<string, unknown>> = [];
  const logger: Logger = createLogger({
    level: "debug",
    clock,
    write: (line) => void lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return {
    dir,
    papHome,
    db,
    clock,
    logger,
    lines,
    /** The folder of a lane under pap's home. */
    folder: (laneId: string) => join(papHome, "worktrees", laneId),
    logged: (msg: string) => lines.filter((line) => line.msg === msg),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
export type WorktreesBed = ReturnType<typeof createWorktreesBed>;
