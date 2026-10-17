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

let root: string;
let db: Db;
let service: SettingsService;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-settings-agents-"));
  const clock = createFakeClock();
  const quiet = createLogger({ level: "error", clock, write: () => {} });
  db = migrate({
    dbPath: join(root, "state.db"),
    backupsDir: join(root, "backups"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger: quiet,
  }).db;
  service = createSettingsService({ store: createSettingsStore(db), clock, logger: quiet });
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const browser = testCaller({ userId: "u1" });
const token = testCaller({ userId: "u1", kind: "token", credentialId: "tok-1" });
const value = {
  newAgent: { sandbox: { required: false, network: true } },
  subagents: { enabled: true, maxConcurrent: 2 },
};

describe("the agents setting (M11R99)", () => {
  it("is the browser's: a token is refused with forbidden and nothing is written", () => {
    expect(() => service.set(token, { key: "agents", value, baseRevision: 0 })).toThrow(
      new PapError("forbidden"),
    );
    expect(service.get(browser, "agents")).toEqual({ value: null, revision: 0 });
  });

  it("is stored by the browser with compare-and-set", () => {
    expect(service.set(browser, { key: "agents", value, baseRevision: 0 })).toEqual({ revision: 1 });
    expect(() => service.set(browser, { key: "agents", value, baseRevision: 0 })).toThrow(
      new PapError("conflict"),
    );
    expect(service.get(token, "agents")).toEqual({ value, revision: 1 });
  });
});
