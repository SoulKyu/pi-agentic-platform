import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { SETTINGS_MIGRATIONS } from "./index.ts";
import { createSettingsService, type SettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";
import { noCap } from "./testing/no-cap.ts";

let root: string;
let db: Db;
let service: SettingsService;
let warnings: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-notifications-"));
  warnings = [];
  const clock = createFakeClock();
  const logger = createLogger({
    level: "warn",
    clock,
    write: (line) => warnings.push((JSON.parse(line) as { msg: string }).msg),
  });
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger,
  }).db;
  service = createSettingsService({ store: createSettingsStore(db), clock, logger, members: noCap });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const browser = testCaller({ userId: "u1" });
const token = testCaller({ userId: "u1", kind: "token", credentialId: "tok-1" });
const value = {
  classes: {
    approval: true,
    failed: false,
    budget: true,
    notify: true,
    done: true,
    reply: false,
  },
  muteUntil: 5_000,
  titles: "names",
} as const;

describe("the notifications setting (M12R18, M12-RT-29)", () => {
  it("is the browser's: a token is refused with forbidden and nothing is written", () => {
    expect(() => service.set(token, { key: "notifications", value, baseRevision: 0 })).toThrow(
      new PapError("forbidden"),
    );
    expect(service.get(browser, "notifications")).toEqual({ value: null, revision: 0 });
  });

  it("is stored by the browser with compare-and-set, and read back by the port", () => {
    expect(service.set(browser, { key: "notifications", value, baseRevision: 0 })).toEqual({ revision: 1 });
    expect(() => service.set(browser, { key: "notifications", value, baseRevision: 0 })).toThrow(
      new PapError("conflict"),
    );
    expect(service.notifications("u1")).toEqual(value);
  });

  it("reads the full defaults when nothing is stored", () => {
    expect(service.notifications("u2")).toEqual({
      classes: {
        approval: true,
        failed: true,
        budget: true,
        notify: true,
        done: false,
        reply: false,
      },
      muteUntil: null,
      titles: "generic",
    });
  });

  it("reads the defaults, logged, when the stored row no longer parses", () => {
    db.run(
      `INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u3', 'notifications', '{"titles":"free"}', 1, 1)`,
    );
    expect(service.notifications("u3").titles).toBe("generic");
    expect(warnings).toContain("settings_row_unreadable");
  });
});
