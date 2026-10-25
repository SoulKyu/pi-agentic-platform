import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationSettings } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { SETTINGS_MIGRATIONS } from "./index.ts";
import { createSettingsService, type SettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";

let root: string;
let db: Db;
let service: SettingsService;
const disabled = new Set<string>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-disabled-"));
  const clock = createFakeClock();
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  disabled.clear();
  service = createSettingsService({
    store: createSettingsStore(db),
    clock,
    logger: silentLogger,
    members: {
      capOf: (userId) => (userId === "m1" ? 5 : null),
      ownerId: () => "o1",
      disabled: (userId) => disabled.has(userId),
    },
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("a disabled account's automation is paused (M14 RT-03, the first chokepoint)", () => {
  it("reads paused whatever is stored, and is back to the stored setting on enable", () => {
    service.set(testCaller({ userId: "m1" }), {
      key: "automation",
      value: AutomationSettings.parse({ paused: false, dailyBudgetUsd: 2 }),
      baseRevision: 0,
    });
    expect(service.automation("m1").paused).toBe(false);
    disabled.add("m1");
    expect(service.automation("m1")).toMatchObject({ paused: true, dailyBudgetUsd: 2 });
    disabled.delete("m1");
    expect(service.automation("m1").paused).toBe(false);
  });

  it("covers an account with no stored setting, and never writes the pause", () => {
    disabled.add("m2");
    expect(service.automation("m2").paused).toBe(true);
    expect(service.get(testCaller({ userId: "m2" }), "automation").revision).toBe(0);
    disabled.delete("m2");
    expect(service.automation("m2").paused).toBe(false);
  });
});
