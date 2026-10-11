import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
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
});
