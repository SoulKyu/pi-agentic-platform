import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { kernelBeforeOutbox } from "../../kernel/testing/old-kernel.ts";
import { POLICY_MIGRATIONS } from "../policy/index.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createSessionsStore, type SessionRow, type SessionsStore } from "./store.ts";

let dir: string;
let db: Db;
let store: SessionsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-sessions-store-"));
  db = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SESSIONS_MIGRATIONS],
    clock: createFakeClock(),
    logger: silentLogger,
  }).db;
  store = createSessionsStore(db);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const draft = (id: string, ownerId = "u1"): SessionRow => ({
  id,
  piPath: null,
  piSessionId: null,
  cwd: "/w",
  ownerId,
  name: null,
  createdAt: 1,
  updatedAt: 1,
});

describe("sessions store", () => {
  it("keeps a draft without a Pi file, and any number of them", () => {
    store.insert(draft("a"));
    store.insert(draft("b"));
    expect(store.get("a")).toEqual(draft("a"));
    expect(store.get("missing")).toBeUndefined();
  });

  it("binds the Pi file and its session id once, and refuses to bind a second time", () => {
    store.insert(draft("a"));
    expect(store.bindPiFile("a", "/s/a.jsonl", "pi-1")).toBe(true);
    expect(store.get("a")).toMatchObject({ piPath: "/s/a.jsonl", piSessionId: "pi-1" });
    expect(store.bindPiFile("a", "/s/other.jsonl", "pi-2")).toBe(false);
    expect(store.get("a")).toMatchObject({ piPath: "/s/a.jsonl", piSessionId: "pi-1" });
  });

  it("never lets two sessions own the same Pi file", () => {
    store.insert(draft("a"));
    store.insert(draft("b"));
    store.bindPiFile("a", "/s/a.jsonl", "pi-1");
    expect(() => store.bindPiFile("b", "/s/a.jsonl", "pi-2")).toThrow();
    expect(store.get("b")?.piPath).toBeNull();
  });

  it("lists one owner's sessions, the most recently used first", () => {
    store.insert({ ...draft("old"), updatedAt: 1 });
    store.insert({ ...draft("new"), updatedAt: 5 });
    store.insert(draft("other", "u2"));
    expect(store.listByOwner("u1").map((row) => row.id)).toEqual(["new", "old"]);
    store.touch("old", 9);
    expect(store.listByOwner("u1").map((row) => row.id)).toEqual(["old", "new"]);
  });

  it("appends events that belong to a session, and only to a session that exists", () => {
    store.insert(draft("a"));
    store.appendEvent("a", "run_start", { origin: "user" }, 7);
    expect(
      db.all("SELECT session_id AS sessionId, kind, data, created_at AS at FROM session_events"),
    ).toEqual([{ sessionId: "a", kind: "run_start", data: '{"origin":"user"}', at: 7 }]);
    expect(() => store.appendEvent("ghost", "run_start", {}, 7)).toThrow();
  });

  it("keeps a name, replaces it, clears it, and refuses one over 256 characters", () => {
    store.insert(draft("a"));
    store.setName("a", "Fix login");
    expect(store.get("a")?.name).toBe("Fix login");
    store.setName("a", "😀".repeat(256));
    expect(store.get("a")?.name).toBe("😀".repeat(256));
    store.setName("a", null);
    expect(store.get("a")?.name).toBeNull();
    expect(() => store.setName("a", "x".repeat(257))).toThrow();
    expect(() => store.setName("ghost", "x")).not.toThrow();
  });
});

describe("marks columns on the store", () => {
  it("stores the project given to insert, none otherwise, and mirrors the database's read-only flag", () => {
    store.insert(draft("a"), "p1");
    store.insert(draft("b"));
    expect(createSessionsStore(db).marks.row("a")?.projectId).toBe("p1");
    expect(createSessionsStore(db).marks.row("b")?.projectId).toBeNull();
    expect(createSessionsStore(db).readOnly).toBe(false);
  });
});

describe("the session_name migration", () => {
  it("is accepted by a database that already holds the policy migration, and adds the column", () => {
    const old = join(dir, "old-sessions");
    mkdirSync(old);
    copyFileSync(
      join(fileURLToPath(new URL("./migrations/", import.meta.url)), "202610100200_sessions.sql"),
      join(old, "202610100200_sessions.sql"),
    );
    // The policy module as it was then: its later migrations (session_policy) come with the second run.
    const oldPolicy = join(dir, "old-policy");
    mkdirSync(oldPolicy);
    copyFileSync(
      join(fileURLToPath(new URL("../policy/migrations/", import.meta.url)), "202610110100_policy.sql"),
      join(oldPolicy, "202610110100_policy.sql"),
    );
    const options = {
      dbPath: join(dir, "m.db"),
      backupsDir: join(dir, "mb"),
      clock: createFakeClock(),
      logger: silentLogger,
    };
    const first = migrate({
      ...options,
      sources: [
        kernelBeforeOutbox(dir),
        { module: "policy", dir: oldPolicy },
        { module: "sessions", dir: old },
      ],
    });
    expect(first.applied).toContain("policy/202610110100_policy.sql");
    first.db.close();
    const second = migrate({
      ...options,
      sources: [KERNEL_MIGRATIONS, POLICY_MIGRATIONS, SESSIONS_MIGRATIONS],
    });
    expect(second.applied).toEqual([
      "sessions/202610110200_session_name.sql",
      "sessions/202610121500_session_marks.sql",
      "policy/202610122010_session_policy.sql",
      "policy/202610131000_pattern_rules.sql",
      "sessions/202610131020_pap_wrote_at.sql",
      "sessions/202610131030_tool_preset.sql",
      "kernel/202610142000_outbox.sql",
      "policy/202610142040_tool_allowlist.sql",
      "sessions/202610151100_session_kinds.sql",
      "sessions/202610151152_owner_preset.sql",
    ]);
    expect(second.readOnly).toBe(false);
    second.db.close();
  });
});
