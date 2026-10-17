import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInput } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { type Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AGENTS_MIGRATIONS } from "./index.ts";
import { createAgentStore } from "./store.ts";

const dirs: string[] = [];
const open = (): Db => {
  const dir = mkdtempSync(join(tmpdir(), "pap-agents-store-"));
  dirs.push(dir);
  return migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, AGENTS_MIGRATIONS],
    clock: createFakeClock(1),
    logger: silentLogger,
  }).db;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const insert = (db: Db, id: string, profile: string, name = "Atlas", ownerId = "u1"): void =>
  void db.run(
    `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
     VALUES ($id, $ownerId, $name, lower($name), $profile, 1, 1)`,
    { id, ownerId, name, profile },
  );

describe("the agent store", () => {
  it("parses the profile again at every read", () => {
    const db = open();
    const store = createAgentStore(db);
    insert(db, "atlas-1a2b", JSON.stringify(AgentInput.parse({ name: "Atlas", role: "Help." })));
    const record = store.get("u1", "atlas-1a2b");
    expect(record?.input).toMatchObject({ name: "Atlas", role: "Help.", mode: "auto-accept-edits" });
    expect(record).toMatchObject({ id: "atlas-1a2b", ownerId: "u1", revision: 1, paused: false, unread: 0 });
  });

  it("reads a profile that no longer parses as unreadable: listed, input null", () => {
    const db = open();
    const store = createAgentStore(db);
    insert(db, "atlas-1a2b", "{}");
    insert(db, "bolt-0001", JSON.stringify({ name: "Bolt", mode: "root" }), "Bolt");
    insert(db, "cato-0002", JSON.stringify(AgentInput.parse({ name: "Other" })), "Cato");
    expect(store.get("u1", "atlas-1a2b")?.input).toBeNull();
    expect(store.get("u1", "bolt-0001")?.input).toBeNull();
    // The column and the profile must agree on the name: a hand-edited row is unreadable, not half-trusted.
    expect(store.get("u1", "cato-0002")?.input).toBeNull();
    expect(store.list("u1").map((record) => record.id)).toEqual(["atlas-1a2b", "bolt-0001", "cato-0002"]);
  });

  it("answers null for another owner's id and finds a name whatever its case", () => {
    const db = open();
    const store = createAgentStore(db);
    insert(db, "atlas-1a2b", JSON.stringify(AgentInput.parse({ name: "Atlas" })));
    expect(store.get("u2", "atlas-1a2b")).toBeNull();
    expect(store.byName("u2", "atlas")).toBeNull();
    expect(store.byName("u1", "ATLAS")?.id).toBe("atlas-1a2b");
    expect(store.list("u2")).toEqual([]);
    expect(store.count("u1")).toBe(1);
    expect(store.remove("u2", "atlas-1a2b")).toBe(false);
    expect(store.get("u1", "atlas-1a2b")).not.toBeNull();
  });

  it("refuses a second agent whose name differs only by case", () => {
    const db = open();
    insert(db, "atlas-1a2b", "{}");
    expect(() => insert(db, "atlas-3c4d", "{}", "ATLAS")).toThrow(/UNIQUE/);
    insert(db, "atlas-3c4d", "{}", "ATLAS", "u2");
  });

  it("is compare-and-set on the revision and keeps a quarantine paused", () => {
    const db = open();
    const store = createAgentStore(db);
    insert(db, "atlas-1a2b", "{}");
    const change = { name: "Atlas", profile: "{}", at: 2 };
    expect(store.update("u1", "atlas-1a2b", 2, change)).toBe(false);
    expect(store.update("u1", "atlas-1a2b", 1, change)).toBe(true);
    expect(store.get("u1", "atlas-1a2b")?.revision).toBe(2);
    expect(store.quarantine("u1", "atlas-1a2b", 3)).toBe(true);
    expect(store.get("u1", "atlas-1a2b")).toMatchObject({ paused: true, quarantinedAt: 3 });
  });
});
