import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_PERMISSIONS, type Caller } from "@pap/contracts";
import { createFakeClock } from "../../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../../kernel/db/migrate.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import { AUDIT_MIGRATIONS, type AuditPort } from "../../audit/index.ts";
import { AUTH_MIGRATIONS, createTokenService, createTokenStore } from "../index.ts";

export const OWNER_ID = "owner-1";
export const DAY = 24 * 3600 * 1000;

/** A real database with the owner row, a fake clock, a recording audit port and a counting token store. */
export function createTokenBed(
  options: { ownerPermissions?: ReadonlySet<(typeof ALL_PERMISSIONS)[number]> } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "pap-tokens-"));
  const clock = createFakeClock();
  const db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, AUTH_MIGRATIONS, AUDIT_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  db.run("INSERT INTO users (id, username, password_hash, created_at) VALUES ($id, 'owner', 'x', 0)", {
    id: OWNER_ID,
  });
  const real = createTokenStore(db);
  let lookups = 0;
  let writes = 0;
  const store = {
    ...real,
    findByHash: (hash: string) => {
      lookups += 1;
      return real.findByHash(hash);
    },
    touch: (id: string, at: number) => {
      writes += 1;
      real.touch(id, at);
    },
  };
  const audit = { lines: [] as Array<Parameters<AuditPort["append"]>[0]> };
  const auditPort: Pick<AuditPort, "append"> = { append: (line) => void audit.lines.push(line) };
  const ids = { next: 0 };
  const tokens = createTokenService({
    store,
    clock,
    audit: auditPort,
    newId: () => `tok-${ids.next++}`,
    ownerPermissions: () => options.ownerPermissions ?? new Set(ALL_PERMISSIONS),
  });
  return {
    db,
    clock,
    tokens,
    audit,
    lookups: () => lookups,
    writes: () => writes,
    confirmed: (): Caller => testCaller({ userId: OWNER_ID, stepUpUntil: clock.now() + 60_000 }),
    dispose() {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
