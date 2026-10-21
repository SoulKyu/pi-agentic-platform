import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUDIT_MIGRATIONS } from "../audit/index.ts";
import { AGENTS_MIGRATIONS } from "./index.ts";

const LAST = "202610211200_agent_events_egress.sql";
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the egress_refused migration on a populated database (M1)", () => {
  it("keeps the rows and the ids, and the next id carries on after the high-water mark of a deleted agent", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-mig-"));
    const before = join(dir, "agents-before");
    mkdirSync(before);
    for (const file of readdirSync(AGENTS_MIGRATIONS.dir))
      if (file !== LAST) copyFileSync(join(AGENTS_MIGRATIONS.dir, file), join(before, file));
    const options = {
      dbPath: join(dir, "state.db"),
      backupsDir: join(dir, "backups"),
      clock: createFakeClock(),
      logger: silentLogger,
    };
    const old = migrate({
      ...options,
      sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS, { module: AGENTS_MIGRATIONS.module, dir: before }],
    }).db;
    for (const id of ["keep-0001", "gone-0002"])
      old.run(
        `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at) VALUES ($id, 'u1', $id, $id, '{}', 1, 1)`,
        { id },
      );
    const insert = (agent: string, n: number) =>
      old.run(
        `INSERT INTO agent_events (agent_id, owner_id, kind, data, at) VALUES ($agent, 'u1', 'notify', '{"n":${n}}', $n)`,
        { agent, n },
      );
    for (let n = 1; n <= 5; n++) insert("keep-0001", n);
    for (let n = 6; n <= 8; n++) insert("gone-0002", n);
    // Cascade: the newest rows (ids 6 to 8) go with their agent; the high-water mark stays 8.
    old.run(`DELETE FROM agents WHERE id = 'gone-0002'`);
    expect(old.get<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'agent_events'`)?.seq).toBe(
      8,
    );
    old.close();

    const db = migrate({ ...options, sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS, AGENTS_MIGRATIONS] }).db;
    expect(db.all<{ id: number }>(`SELECT id FROM agent_events ORDER BY id`).map((row) => row.id)).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);
    db.run(
      `INSERT INTO agent_events (agent_id, owner_id, kind, data, at) VALUES ('keep-0001', 'u1', 'egress_refused', '{}', 9)`,
    );
    expect(db.get<{ id: number }>(`SELECT max(id) AS id FROM agent_events`)?.id).toBe(9);
    db.close();
  });
});
