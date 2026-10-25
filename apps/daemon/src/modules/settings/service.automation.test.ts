import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AutomationSettings, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { SETTINGS_MIGRATIONS } from "./index.ts";
import { settingsRpc } from "./rpc.ts";
import { createSettingsService, type SettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";
import { noCap } from "./testing/no-cap.ts";

let root: string;
let db: Db;
let service: SettingsService;
let lines: string[];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-automation-"));
  const clock = createFakeClock();
  const quiet = createLogger({ level: "error", clock, write: () => {} });
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger: quiet,
  }).db;
  lines = [];
  service = createSettingsService({
    store: createSettingsStore(db),
    clock,
    logger: createLogger({ level: "warn", clock, write: (line) => lines.push(line) }),
    members: noCap,
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const browser = testCaller({ userId: "u1" });
const token = testCaller({ userId: "u1", kind: "token", credentialId: "tok-1" });
const settings = (patch: Record<string, unknown> = {}) => AutomationSettings.parse(patch);
const stored = () =>
  db.all<{ value: string; revision: number }>(
    "SELECT value, revision FROM settings WHERE key = 'automation'",
  );

describe("the automation settings port", () => {
  it("is the defaults for a missing row", () => {
    expect(service.automation("u1")).toEqual(settings());
    expect(service.automation("u1")).toMatchObject({ paused: false, dailyBudgetUsd: 5, autoResume: true });
  });

  it("is the stored document, per owner", () => {
    service.set(browser, {
      key: "automation",
      value: settings({ dailyBudgetUsd: 12, paused: true }),
      baseRevision: 0,
    });
    expect(service.automation("u1")).toMatchObject({ dailyBudgetUsd: 12, paused: true });
    expect(service.automation("u2")).toEqual(settings());
  });

  it("is the defaults for a damaged row, and says so without the value", () => {
    db.run(
      "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'automation', '{\"dailyBudgetUsd\":\"secret-x\"}', 1, 0)",
    );
    expect(service.automation("u1")).toEqual(settings());
    expect(lines.join("\n")).toContain("settings_row_unreadable");
    expect(lines.join("\n")).not.toContain("secret-x");
  });

  it("is the defaults for a row that is not JSON", () => {
    db.run(
      "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'automation', '{oops', 1, 0)",
    );
    expect(service.automation("u1")).toEqual(settings());
  });
});

describe("a token and the automation setting (M10R162, RT-04)", () => {
  it("is refused with forbidden by the real settings service, and nothing is written", () => {
    expect(() =>
      service.set(token, { key: "automation", value: settings({ dailyBudgetUsd: null }), baseRevision: 0 }),
    ).toThrow(new PapError("forbidden"));
    expect(stored()).toEqual([]);
    expect(service.automation("u1").dailyBudgetUsd).toBe(5);
  });

  it("cannot lift a budget the browser set, nor unpause", () => {
    service.set(browser, {
      key: "automation",
      value: settings({ dailyBudgetUsd: 2, paused: true }),
      baseRevision: 0,
    });
    expect(() =>
      service.set(token, {
        key: "automation",
        value: settings({ dailyBudgetUsd: null, paused: false }),
        baseRevision: 1,
      }),
    ).toThrow(new PapError("forbidden"));
    expect(service.automation("u1")).toMatchObject({ dailyBudgetUsd: 2, paused: true });
    expect(stored()).toHaveLength(1);
    expect(stored()[0]?.revision).toBe(1);
  });

  it("is refused through the RPC handler a token reaches, too", async () => {
    const handlers = settingsRpc(service);
    await expect(
      handlers["settings.set"](
        { key: "automation", value: settings({ slots: 8 }), baseRevision: 0 },
        {
          caller: token,
          connectionId: "c",
          openSubscription: () => "",
          closeSubscription: () => {},
        },
      ),
    ).rejects.toThrow(new PapError("forbidden"));
    expect(stored()).toEqual([]);
  });

  it("still lets a token write the other settings (its permission is settings:operate)", () => {
    expect(service.set(token, { key: "models", value: { modelsDevPricing: true }, baseRevision: 0 })).toEqual(
      { revision: 1 },
    );
  });

  it("lets the browser store it with compare-and-set", () => {
    expect(
      service.set(browser, { key: "automation", value: settings({ slots: 2 }), baseRevision: 0 }),
    ).toEqual({ revision: 1 });
    expect(() =>
      service.set(browser, { key: "automation", value: settings({ slots: 3 }), baseRevision: 0 }),
    ).toThrow(new PapError("conflict"));
    expect(
      service.set(browser, { key: "automation", value: settings({ slots: 3 }), baseRevision: 1 }),
    ).toEqual({ revision: 2 });
    expect(service.automation("u1").slots).toBe(3);
  });

  it("can still read it (settings:read)", () => {
    expect(service.get(token, "automation")).toEqual({ value: null, revision: 0 });
  });
});
