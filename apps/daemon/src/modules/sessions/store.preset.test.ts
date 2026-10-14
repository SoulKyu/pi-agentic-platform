import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { SESSIONS_MIGRATIONS } from "./index.ts";
import { createSessionsStore, type SessionRow, type SessionsStore, toolPresetOf } from "./store.ts";

let dir: string;
let db: Db;
let store: SessionsStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-sessions-preset-"));
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

const row = (id: string, extra: Partial<SessionRow> = {}): SessionRow => ({
  id,
  piPath: null,
  piSessionId: null,
  cwd: "/w",
  ownerId: "u1",
  name: null,
  createdAt: 1,
  updatedAt: 1,
  ...extra,
});

describe("sessions.tool_preset (M7 Task 15, MC20)", () => {
  it("is stamped after Task 3's migration", () => {
    const files = readdirSync(SESSIONS_MIGRATIONS.dir).sort();
    expect(files.indexOf("202610131030_tool_preset.sql")).toBeGreaterThan(
      files.indexOf("202610131020_pap_wrote_at.sql"),
    );
    expect(files.indexOf("202610131020_pap_wrote_at.sql")).toBeGreaterThanOrEqual(0);
  });

  it("is NULL for a row inserted without a preset, and the store says nothing of it", () => {
    store.insert(row("a"));
    expect(store.get("a")).toEqual(row("a"));
    expect(store.toolPreset("a")).toBeNull();
  });

  it("keeps the preset of a new row and changes it", () => {
    store.insert(row("a", { toolPreset: "chat" }));
    expect(store.get("a")?.toolPreset).toBe("chat");
    expect(store.listByOwner("u1")[0]?.toolPreset).toBe("chat");
    store.setToolPreset("a", "read-only");
    expect(store.toolPreset("a")).toBe("read-only");
    store.setToolPreset("a", null);
    expect(store.toolPreset("a")).toBeNull();
    expect(store.get("a")).toEqual(row("a"));
  });

  it("refuses a value outside the list", () => {
    store.insert(row("a"));
    expect(() => db.run("UPDATE sessions SET tool_preset = 'bogus' WHERE id = 'a'")).toThrow();
    expect(() => db.run("UPDATE sessions SET tool_preset = 'configured' WHERE id = 'a'")).toThrow();
    expect(store.toolPreset("a")).toBeNull();
  });

  it("reads a value it does not know as chat, the narrowest preset (fail closed)", () => {
    expect(toolPresetOf(null)).toBeNull();
    expect(toolPresetOf(undefined)).toBeNull();
    expect(toolPresetOf("read-only")).toBe("read-only");
    expect(toolPresetOf("bogus")).toBe("chat");
    expect(toolPresetOf("configured")).toBe("chat");
    expect(toolPresetOf(7)).toBe("chat");
  });
});
