import { join } from "node:path";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createDenySet } from "../../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../../kernel/git/runner.ts";
import { createBoundaryBed } from "../../../kernel/testing/boundary-bed.ts";
import { createGitBed } from "../../../kernel/testing/git-bed.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import type { AuditPort } from "../../audit/index.ts";
import { LANES_MIGRATIONS } from "../index.ts";

type AuditLine = Parameters<AuditPort["append"]>[0];

/** A real database with the lanes tables, a real repository (`gb.root`), a boundary and a capturing audit port. */
export function createLanesBed() {
  const bb = createBoundaryBed();
  const gb = createGitBed();
  // Far ahead of every file the beds make: the deny set sees no file as changed since a walk.
  const clock: FakeClock = createFakeClock(Date.now() + 3_600_000);
  const { logger, lines } = captureLogger();
  const deny = createDenySet(bb.denySources(), clock);
  const git: GitRunner = gb.runner();
  const db: Db = migrate({
    dbPath: join(gb.dir, "lanes.db"),
    backupsDir: join(gb.dir, "backups"),
    sources: [KERNEL_MIGRATIONS, LANES_MIGRATIONS],
    clock,
    logger,
  }).db;
  const audit: AuditLine[] = [];
  const projects = new Map<string, string[]>([["u1", [gb.root]]]);
  return {
    bb,
    gb,
    clock,
    logger,
    lines,
    deny,
    git,
    db,
    audit,
    projects,
    deps: {
      db,
      git,
      clock,
      logger,
      boundary: bb.config(),
      deny,
      roots: (ownerId: string): readonly string[] => projects.get(ownerId) ?? [],
      audit: { append: (line: AuditLine): void => void audit.push(line) },
      readOnly: false,
    },
    dispose(): void {
      db.close();
      bb.dispose();
      gb.dispose();
    },
  };
}
export type LanesBed = ReturnType<typeof createLanesBed>;
