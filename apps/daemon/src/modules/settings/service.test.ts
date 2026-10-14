import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SETTING_BYTES, PapError, type AccountAppearance, type Caller } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createSettingsService, type SettingsService } from "./service.ts";
import { createSettingsStore } from "./store.ts";
import { SETTINGS_MIGRATIONS } from "./index.ts";
import { testCaller } from "../../testing/caller.ts";

const owner = (userId: string): Caller => testCaller({ userId });
const appearance: AccountAppearance = {
  mode: "day",
  darkTheme: "night",
  lightTheme: "day",
  customThemes: [],
  uiFont: "system",
  monoFont: "jetbrains-mono",
  uppercaseLabels: false,
  grid: true,
  railPosition: "right",
  avatarStyle: "glyph",
  toolDetail: "full",
} as const;

let root: string;
let db: Db;
let service: SettingsService;
let lines: string[];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-"));
  const clock = createFakeClock();
  const logger = createLogger({ level: "error", clock, write: () => {} });
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger,
  }).db;
  lines = [];
  service = createSettingsService({
    store: createSettingsStore(db),
    clock,
    logger: createLogger({ level: "warn", clock, write: (line) => lines.push(line) }),
  });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

describe("settings service", () => {
  it("reads nothing before the first write", () => {
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: null, revision: 0 });
  });

  it("stores a document per owner and key and bumps its revision", () => {
    expect(service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 0 })).toEqual({
      revision: 1,
    });
    expect(
      service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 1 }),
    ).toEqual({ revision: 2 });
    expect(service.get(owner("u1"), "appearance")).toEqual({
      value: { ...appearance, grid: false },
      revision: 2,
    });
    expect(service.get(owner("u2"), "appearance")).toEqual({ value: null, revision: 0 });
    expect(service.get(owner("u1"), "keybindings")).toEqual({ value: null, revision: 0 });
  });

  it("a stale baseRevision is refused and the stored document is unchanged", () => {
    service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 0 });
    expect(() =>
      service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 0 }),
    ).toThrow(new PapError("conflict"));
    expect(() =>
      service.set(owner("u1"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 7 }),
    ).toThrow(new PapError("conflict"));
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: appearance, revision: 1 });
  });

  it("another owner's write never touches this owner's document", () => {
    service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 0 });
    expect(() =>
      service.set(owner("u2"), { key: "appearance", value: { ...appearance, grid: false }, baseRevision: 1 }),
    ).toThrow(new PapError("conflict"));
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: appearance, revision: 1 });
    expect(service.get(owner("u2"), "appearance")).toEqual({ value: null, revision: 0 });
  });

  it("refuses a value over 128 KiB and stores nothing", () => {
    // "é" is two bytes in UTF-8 and one character for the schema's 256-character limit (M3-RT-08).
    const rules = Array.from({ length: 256 }, (_, i) => ({
      key: "mod+k",
      command: `x.${"a".repeat(120)}${i}`,
      when: "é".repeat(256),
    }));
    expect(Buffer.byteLength(JSON.stringify(rules), "utf8")).toBeGreaterThan(MAX_SETTING_BYTES);
    expect(() => service.set(owner("u1"), { key: "keybindings", value: rules, baseRevision: 0 })).toThrow(
      new PapError("payload_too_large"),
    );
    expect(service.get(owner("u1"), "keybindings")).toEqual({ value: null, revision: 0 });
  });

  it("reads a damaged row as no setting, logs the key, never the value, and lets the next write replace it", () => {
    db.run(
      "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'appearance', '{oops-secret', 3, 0)",
    );
    expect(service.get(owner("u1"), "appearance")).toEqual({ value: null, revision: 3 });
    expect(lines.join("\n")).toContain("settings_row_unreadable");
    expect(lines.join("\n")).not.toContain("oops-secret");
    expect(service.set(owner("u1"), { key: "appearance", value: appearance, baseRevision: 3 })).toEqual({
      revision: 4,
    });
  });
  it("reads the models setting as off with no row, a damaged row, or a value of the wrong type (M7R138)", () => {
    expect(service.models("u1")).toEqual({ modelsDevPricing: false });
    db.run(
      "INSERT INTO settings (owner_id, key, value, revision, updated_at) VALUES ('u1', 'models', '{oops-secret', 1, 0)",
    );
    expect(service.models("u1")).toEqual({ modelsDevPricing: false });
    expect(lines.join("\n")).toContain("settings_row_unreadable");
    expect(lines.join("\n")).not.toContain("oops-secret");
    service.set(owner("u1"), { key: "models", value: { modelsDevPricing: true }, baseRevision: 1 });
    db.run(
      "UPDATE settings SET value = '{\"modelsDevPricing\":\"yes\"}' WHERE owner_id = 'u1' AND key = 'models'",
    );
    expect(service.models("u1")).toEqual({ modelsDevPricing: false });
  });

  it("reads the models setting per owner: only the owner who switched it on has it on", () => {
    service.set(owner("u1"), { key: "models", value: { modelsDevPricing: true }, baseRevision: 0 });
    expect(service.models("u1")).toEqual({ modelsDevPricing: true });
    expect(service.models("u2")).toEqual({ modelsDevPricing: false });
  });
});
