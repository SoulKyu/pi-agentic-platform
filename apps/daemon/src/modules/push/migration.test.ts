import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { Db } from "../../kernel/db/database.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUSH_MIGRATIONS } from "./index.ts";

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-push-migration-"));
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

const event = (id: string, key: string, state: string) =>
  db.run(
    `INSERT INTO push_events (id, owner_id, cls, ref_kind, ref_id, dedup_key, state, created_at)
     VALUES ($id, 'u1', 'approval', 'session', 's1', $key, $state, 1)`,
    { id, key, state },
  );
const sub = (id: string, hash: string, owner = "u1") =>
  db.run(
    `INSERT INTO push_subs (id, owner_id, credential_id, key_id, endpoint, endpoint_hash, p256dh, auth, locale, label, created_at)
     VALUES ($id, $owner, 'c1', 'k1', 'https://e', $hash, 'p', 'a', 'en', 'Phone', 1)`,
    { id, hash, owner },
  );

describe("the push migration (202610172000)", () => {
  it("creates the five tables", () => {
    const tables = db
      .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'push_%'")
      .map((row) => row.name);
    expect(tables.sort()).toEqual([
      "push_deliveries",
      "push_events",
      "push_meta",
      "push_revoked",
      "push_subs",
    ]);
  });

  it("lets one live event exist per dedup key, and a settled one does not block a later push", () => {
    event("e1", "push:approval:session:s1", "pending");
    expect(() => event("e2", "push:approval:session:s1", "pending")).toThrow();
    expect(() => event("e3", "push:approval:session:s1", "held")).toThrow();
    db.run("UPDATE push_events SET state = 'sent' WHERE id = 'e1'");
    event("e4", "push:approval:session:s1", "pending");
    event("e5", "push:approval:session:s1", "sent");
    expect(db.all("SELECT id FROM push_events")).toHaveLength(3);
  });

  it("refuses an unknown event or delivery state and an unknown locale", () => {
    expect(() => event("e1", "k", "lost")).toThrow();
    expect(() =>
      db.run("INSERT INTO push_deliveries (event_id, sub_id, state, next_at) VALUES ('e', 's', 'lost', 1)"),
    ).toThrow();
    expect(() =>
      db.run(
        `INSERT INTO push_subs (id, owner_id, credential_id, key_id, endpoint, endpoint_hash, p256dh, auth, locale, label, created_at)
         VALUES ('s', 'u1', 'c', 'k', 'e', 'h', 'p', 'a', 'de', 'l', 1)`,
      ),
    ).toThrow();
  });

  it("keeps one subscription per owner and endpoint hash, the same hash allowed for another owner", () => {
    sub("s1", "h1");
    expect(() => sub("s2", "h1")).toThrow();
    sub("s3", "h1", "u2");
  });

  it("keys a delivery by event and subscription, with zero attempts at the start", () => {
    db.run("INSERT INTO push_deliveries (event_id, sub_id, state, next_at) VALUES ('e', 's', 'pending', 1)");
    expect(() =>
      db.run(
        "INSERT INTO push_deliveries (event_id, sub_id, state, next_at) VALUES ('e', 's', 'pending', 1)",
      ),
    ).toThrow();
    expect(db.get<{ attempts: number }>("SELECT attempts FROM push_deliveries")).toEqual({ attempts: 0 });
  });

  it("holds meta as key and value", () => {
    db.run("INSERT INTO push_meta (key, value) VALUES ('keys_reset', '{}')");
    expect(() => db.run("INSERT INTO push_meta (key, value) VALUES ('keys_reset', '{}')")).toThrow();
  });
});
