import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationSettings, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { SETTINGS_MIGRATIONS } from "./index.ts";
import { createSettingsService, type SettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";

const CAP = 5;
let root: string;
let db: Db;
let service: SettingsService;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-cap-"));
  const clock = createFakeClock();
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
  service = createSettingsService({
    store: createSettingsStore(db),
    clock,
    logger: silentLogger,
    members: {
      capOf: (userId) => (userId === "m1" ? CAP : null),
      ownerId: () => "o1",
      disabled: () => false,
    },
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const owner = testCaller({ userId: "o1" });
const member = testCaller({ userId: "m1" });
const doc = (patch: Record<string, unknown> = {}) => AutomationSettings.parse(patch);
const seed = (userId: string, value: Record<string, unknown>) =>
  db.run(
    "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ($userId, 'automation', $value, 1, 0)",
    { userId, value: JSON.stringify(value) },
  );

describe("a member's automation budget is capped by the owner (RT-06)", () => {
  it("a member cannot raise the budget past the cap", () => {
    expect(() =>
      service.set(member, { key: "automation", value: doc({ dailyBudgetUsd: 50 }), baseRevision: 0 }),
    ).toThrow(new PapError("budget_cap"));
    expect(() =>
      service.set(member, { key: "automation", value: doc({ dailyBudgetUsd: 5.01 }), baseRevision: 0 }),
    ).toThrow(new PapError("budget_cap"));
    expect(service.automation("m1").dailyBudgetUsd).toBe(CAP);
    service.set(member, { key: "automation", value: doc({ dailyBudgetUsd: 2 }), baseRevision: 0 });
    expect(service.automation("m1").dailyBudgetUsd).toBe(2);
    service.set(member, { key: "automation", value: doc({ dailyBudgetUsd: CAP }), baseRevision: 1 });
    expect(service.automation("m1").dailyBudgetUsd).toBe(CAP);
  });

  it("a stored or written null is the cap, never zero and never unlimited", () => {
    expect(() =>
      service.set(member, { key: "automation", value: doc({ dailyBudgetUsd: null }), baseRevision: 0 }),
    ).toThrow(new PapError("budget_cap"));
    seed("m1", { dailyBudgetUsd: null });
    expect(service.automation("m1").dailyBudgetUsd).toBe(CAP);
  });

  it("every gate reads the clamped budget: a stored import above the cap reads as the cap, settings.get too", () => {
    seed("m1", { dailyBudgetUsd: 500, paused: false });
    expect(service.automation("m1").dailyBudgetUsd).toBe(CAP);
    const got = service.get(member, "automation");
    expect(got.revision).toBe(1);
    expect(got.value).toMatchObject({ dailyBudgetUsd: CAP, dailyBudgetCapUsd: CAP });
    expect(service.automation("m1").dailyBudgetCapUsd).toBe(CAP);
  });

  it("a member with no row reads the cap line and the default budget under it", () => {
    expect(service.get(member, "automation").value).toMatchObject({
      dailyBudgetUsd: CAP,
      dailyBudgetCapUsd: CAP,
    });
    const low = createSettingsService({
      store: createSettingsStore(db),
      clock: createFakeClock(),
      logger: silentLogger,
      members: { capOf: () => 3, ownerId: () => "o1", disabled: () => false },
    });
    expect(low.automation("m1").dailyBudgetUsd).toBe(3);
  });

  it("the owner has no cap: null stays unlimited, the cap line is null", () => {
    service.set(owner, { key: "automation", value: doc({ dailyBudgetUsd: null }), baseRevision: 0 });
    expect(service.automation("o1")).toMatchObject({ dailyBudgetUsd: null, dailyBudgetCapUsd: null });
    service.set(owner, { key: "automation", value: doc({ dailyBudgetUsd: 900 }), baseRevision: 1 });
    expect(service.automation("o1").dailyBudgetUsd).toBe(900);
    // A write that echoes the cap it read never stores it.
    service.set(member, {
      key: "automation",
      value: doc({ dailyBudgetUsd: 1, dailyBudgetCapUsd: 999 }),
      baseRevision: 0,
    });
    expect(service.automation("m1").dailyBudgetCapUsd).toBe(CAP);
    const rows = db.all<{ value: string }>(
      "SELECT value FROM settings WHERE owner_id = 'm1' AND key = 'automation'",
    );
    expect(JSON.parse(rows[0]?.value ?? "{}")).toMatchObject({ dailyBudgetCapUsd: null });
  });

  it("the member's time zone stays their own: quiet hours, triggers and the editor read it (R10)", () => {
    seed("o1", { timezone: "Asia/Tokyo" });
    seed("m1", { timezone: "Pacific/Kiritimati", quietHours: { from: "22:00", to: "07:00" } });
    expect(service.automation("m1")).toMatchObject({
      timezone: "Pacific/Kiritimati",
      quietHours: { from: "22:00", to: "07:00" },
    });
    expect(service.automation("o1").timezone).toBe("Asia/Tokyo");
    expect(service.get(member, "automation").value).toMatchObject({ timezone: "Pacific/Kiritimati" });
  });
});
