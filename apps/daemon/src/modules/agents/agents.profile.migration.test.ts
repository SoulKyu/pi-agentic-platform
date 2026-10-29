import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AUDIT_MIGRATIONS } from "../audit/index.ts";
import { AGENTS_MIGRATIONS } from "./index.ts";

const LAST = "202610291200_agents_profile_unbounded.sql";
let dir = "";
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the unbounded profile migration on a populated database (decision 142)", () => {
  it("keeps agents, cards, requests and ids, keeps the cascades on agents, and takes a profile past 32768", () => {
    dir = mkdtempSync(join(tmpdir(), "pap-mig-"));
    const before = join(dir, "agents-before");
    mkdirSync(before);
    for (const file of readdirSync(AGENTS_MIGRATIONS.dir))
      if (file < LAST) copyFileSync(join(AGENTS_MIGRATIONS.dir, file), join(before, file));
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
    const addAgent = (id: string, profile: string) =>
      old.run(
        `INSERT INTO agents (id, owner_id, name, name_key, profile, revision, created_at, updated_at)
         VALUES ($id, 'u1', $id, $id, $profile, 3, 1, 2)`,
        { id, profile },
      );
    addAgent("keep-0001", '{"role":"kept"}');
    addAgent("gone-0002", "{}");
    for (let n = 1; n <= 4; n++)
      old.run(
        `INSERT INTO agent_events (agent_id, owner_id, kind, data, at) VALUES ($agent, 'u1', 'notify', '{}', $n)`,
        { agent: n <= 2 ? "keep-0001" : "gone-0002", n },
      );
    old.run(
      `INSERT INTO agent_requests (id, agent_id, owner_id, session_id, kind, title, state, created_at, expires_at)
       VALUES ('r1', 'keep-0001', 'u1', 's1', 'approve', 'Deploy', 'pending', 1, 2)`,
    );
    old.run(`DELETE FROM agents WHERE id = 'gone-0002'`);
    expect(() => addAgent("long-0003", JSON.stringify({ role: "r".repeat(40_000) }))).toThrow(/CHECK/);
    old.close();

    const db = migrate({ ...options, sources: [KERNEL_MIGRATIONS, AUDIT_MIGRATIONS, AGENTS_MIGRATIONS] }).db;
    expect(db.all(`SELECT id, profile, revision FROM agents`)).toEqual([
      { id: "keep-0001", profile: '{"role":"kept"}', revision: 3 },
    ]);
    expect(db.all<{ id: number }>(`SELECT id FROM agent_events ORDER BY id`).map((row) => row.id)).toEqual([
      1, 2,
    ]);
    expect(db.all(`SELECT id, state FROM agent_requests`)).toEqual([{ id: "r1", state: "pending" }]);
    expect(db.all(`PRAGMA foreign_key_check`)).toEqual([]);

    db.run(
      `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
       VALUES ('long-0003', 'u1', 'long-0003', 'long-0003', $profile, 1, 1)`,
      { profile: JSON.stringify({ role: "r".repeat(100_000) }) },
    );
    db.run(
      `INSERT INTO agent_events (agent_id, owner_id, kind, data, at) VALUES ('long-0003', 'u1', 'notify', '{}', 5)`,
    );
    expect(db.get<{ id: number }>(`SELECT max(id) AS id FROM agent_events`)?.id).toBe(5);
    expect(() =>
      db.run(
        `INSERT INTO agent_events (agent_id, owner_id, kind, data, at) VALUES ('nobody-01', 'u1', 'notify', '{}', 6)`,
      ),
    ).toThrow(/FOREIGN KEY/);

    db.run(`DELETE FROM agents WHERE id = 'keep-0001'`);
    expect(db.get<{ n: number }>(`SELECT count(*) AS n FROM agent_requests`)?.n).toBe(0);
    expect(db.all<{ id: number }>(`SELECT id FROM agent_events`).map((row) => row.id)).toEqual([5]);
    db.close();
  });
});
