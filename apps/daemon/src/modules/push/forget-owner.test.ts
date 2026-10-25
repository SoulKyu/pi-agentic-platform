import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { forgetPushOwner, PUSH_MIGRATIONS } from "./index.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-push-forget-"));
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, PUSH_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(owner: string): void {
  db.run(
    `INSERT INTO push_subs (id, owner_id, credential_id, key_id, endpoint, endpoint_hash, p256dh, auth, locale, label, created_at)
     VALUES ($sub, $owner, 'c1', 'k1', 'https://e', $hash, 'p', 'a', 'en', 'Phone', 1)`,
    { sub: `sub-${owner}`, owner, hash: `h-${owner}` },
  );
  db.run(
    `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
     VALUES ($event, $owner, 'approval', 'session', 's1', $key, 'sent', 1)`,
    { event: `ev-${owner}`, owner, key: `k-${owner}` },
  );
  db.run("INSERT INTO push_revoked (owner_id, endpoint_hash, revoked_at) VALUES ($owner, 'old', 1)", {
    owner,
  });
  db.run("INSERT INTO push_deliveries (event_id, sub_id, state, next_at) VALUES ($event, $sub, 'done', 1)", {
    event: `ev-${owner}`,
    sub: `sub-${owner}`,
  });
}
const count = (table: string): number => db.get<{ n: number }>(`SELECT count(*) AS n FROM ${table}`)?.n ?? 0;

describe("forgetPushOwner (a member's delete, A5b)", () => {
  it("removes the owner's subscriptions, revoked endpoints, events and the deliveries of both, and nobody else's", () => {
    seed("m1");
    seed("u1");
    expect(forgetPushOwner(db, "m1")).toBe(1);
    for (const table of ["push_subs", "push_events", "push_revoked", "push_deliveries"])
      expect(count(table), table).toBe(1);
    expect(db.get<{ sub_id: string }>("SELECT sub_id FROM push_deliveries")?.sub_id).toBe("sub-u1");
    expect(forgetPushOwner(db, "m1")).toBe(0);
  });
});
