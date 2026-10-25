import { AutomationSettings } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "./kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "./kernel/db/migrate.ts";
import { silentLogger } from "./kernel/logger.ts";
import {
  createRunnerBed,
  effectContext,
  fireInput,
  type RunnerBed,
} from "./modules/automation/testing/runner-bed.ts";
import { createSettingsModule, SETTINGS_MIGRATIONS, type SettingsPort } from "./modules/settings/index.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/*
 * M14 RT-03: one chokepoint, not a list. The real settings service says `paused` for a disabled account, and the three
 * consumers the red team named (a queued task, a trigger or reminder firing) read only that.
 */
const off = new Set<string>();
let dir: string;
let settings: SettingsPort;
let close: () => void;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-users-disabled-"));
  const clock = createFakeClock();
  const { db } = migrate({
    dbPath: join(dir, "s.db"),
    backupsDir: join(dir, "b"),
    sources: [KERNEL_MIGRATIONS, SETTINGS_MIGRATIONS],
    clock,
    logger: silentLogger,
  });
  off.clear();
  settings = createSettingsModule({
    db,
    clock,
    logger: silentLogger,
    members: { capOf: () => null, ownerId: () => "o1", disabled: (userId) => off.has(userId) },
  }).port;
  close = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
});
afterEach(() => close());

describe("a disabled account starts nothing", () => {
  let bed: RunnerBed;
  afterEach(() => bed.dispose());

  it("a trigger or reminder that fires after the disable is refused paused, and a queued task waits", async () => {
    bed = createRunnerBed();
    bed.settings.owners.get = (ownerId) => settings.automation(ownerId) as AutomationSettings;
    const trigger = bed.trigger();
    const revision = bed.triggers.get("u1", trigger.id)?.revision ?? 0;
    const queued = bed.engine.fire(trigger.id, revision, fireInput());
    expect(queued.verdict).toBe("fired");
    off.add("u1");
    expect(bed.engine.fire(trigger.id, revision, fireInput()).verdict).toBe("paused");
    expect(await bed.engine.runner.handleStart({ taskId: "any" }, effectContext())).toEqual({
      outcome: "defer",
      until: bed.clock.now() + 30_000,
    });
    expect(bed.sessions.createTaskSession).not.toHaveBeenCalled();
    off.delete("u1");
    expect(await bed.engine.runner.handleStart({ taskId: "any" }, effectContext())).toEqual({
      outcome: "done",
    });
    expect(bed.sessions.createTaskSession).toHaveBeenCalledTimes(1);
  });
});
