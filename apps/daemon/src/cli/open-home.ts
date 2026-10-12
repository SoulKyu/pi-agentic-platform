import { existsSync } from "node:fs";
import { join } from "node:path";
import { homeFrom } from "../kernel/config.ts";
import type { Clock } from "../kernel/clock.ts";
import type { Db } from "../kernel/db/database.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { acquireInstanceLock, prepareHome } from "../kernel/home.ts";
import { silentLogger } from "../kernel/logger.ts";
import { MIGRATION_SOURCES } from "../daemon.ts";

export interface CliIo {
  readonly stdin: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly env: NodeJS.ProcessEnv;
  readonly homedir: string;
  readonly clock: Clock;
}

/** A refusal with a one-line message: `pap: <message>` and exit code 1. */
export class CliError extends Error {
  override name = "CliError";
}

export interface OpenedHome {
  readonly home: string;
  readonly db: Db;
  /** Closes the database, then releases the instance lock. */
  close(): void;
}

/**
 * Opens `$PAP_HOME` the way the daemon does: same private modes, same instance lock, same migrations. The lock is
 * what makes a CLI command run only while the daemon is stopped (single writer, spec C §3.2). A database written by a
 * newer pap is refused, never opened read-only: an admin command that cannot write has nothing to do.
 */
export async function openHomeForCli(io: CliIo, options: { create: boolean }): Promise<OpenedHome> {
  const home = homeFrom(io.env, io.homedir);
  const dbPath = join(home, "state.db");
  if (!options.create && !existsSync(dbPath)) throw new CliError(`no pap data in ${home}`);
  prepareHome(home);
  const lock = acquireInstanceLock(home);
  try {
    const { db, readOnly } = migrate({
      dbPath,
      backupsDir: join(home, "backups"),
      sources: MIGRATION_SOURCES,
      clock: io.clock,
      logger: silentLogger,
    });
    if (readOnly) {
      db.close();
      throw new CliError("the database was written by a newer pap; upgrade pap first");
    }
    return {
      home,
      db,
      close() {
        try {
          db.close();
        } finally {
          lock.release();
        }
      },
    };
  } catch (error) {
    lock.release();
    throw error;
  }
}
