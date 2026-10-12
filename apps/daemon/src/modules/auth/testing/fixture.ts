import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { createFakeClock, type FakeClock } from "../../../kernel/clock.ts";
import type { Db } from "../../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { createHttpApp } from "../../../kernel/http/app.ts";
import { createLogger, type Logger } from "../../../kernel/logger.ts";
import type { AuditPort } from "../../audit/index.ts";
import { AUTH_MIGRATIONS, createAuthModule, type AuthModule } from "../index.ts";

// Shared by the auth tests (compiled out of the build with the rest of `testing/`): a migrated temporary
// database, a fake clock, a logger whose lines the test can read, and the module behind the real HTTP app.
export const PASSWORD = "correct horse battery staple";

export type AuditedLine = Parameters<AuditPort["append"]>[0];

export interface AuthTestBed {
  readonly db: Db;
  /** The database file, for a test that opens it a second time (read-only, say). */
  readonly dbPath: string;
  readonly clock: FakeClock;
  readonly logger: Logger;
  /** Every log line since the bed was created or last cleared; migration output is already dropped. */
  readonly lines: string[];
  /** Every line the auth module handed to the audit port. */
  readonly audited: AuditedLine[];
  start(
    publicOrigin: string,
    allowedOrigins?: ReadonlySet<string>,
    insecureHttp?: boolean,
  ): { auth: AuthModule; app: Hono };
  events(name: string): Record<string, unknown>[];
  dispose(): void;
}

export function createAuthTestBed(): AuthTestBed {
  const dir = mkdtempSync(join(tmpdir(), "pap-auth-"));
  const clock = createFakeClock();
  const lines: string[] = [];
  const audited: AuditedLine[] = [];
  const logger = createLogger({ level: "debug", clock, write: (line) => lines.push(line) });
  const dbPath = join(dir, "s.db");
  const db = migrate({
    dbPath,
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS],
    clock,
    logger,
  }).db;
  lines.length = 0;
  return {
    db,
    dbPath,
    clock,
    logger,
    lines,
    audited,
    start(publicOrigin, allowedOrigins = new Set([publicOrigin]), insecureHttp = false) {
      const auth = createAuthModule({
        db,
        clock,
        logger,
        publicOrigin,
        allowedOrigins,
        insecureHttp,
        audit: { append: (line) => void audited.push(line) },
      });
      const app = createHttpApp({
        allowedOrigins,
        staticRoot: null,
        logger,
        mount: (a) => auth.mount(a),
        wsProbe: (c) => c.json({}),
      });
      return { auth, app };
    },
    events: (name) =>
      lines.map((line) => JSON.parse(line) as Record<string, unknown>).filter((entry) => entry.msg === name),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** The raw token of the one-time setup URL. */
export const setupTokenOf = (auth: AuthModule): string =>
  new URL(auth.setupUrl() ?? "http://x").hash.replace("#token=", "");
