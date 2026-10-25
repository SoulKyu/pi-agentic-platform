import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { createSettingsModule, SETTINGS_MIGRATIONS, type SettingsPort } from "../settings/index.ts";
import { createResume } from "./resume.ts";
import { createRunsService } from "./service.ts";
import { createRunsStore } from "./store.ts";
import { openResumeBed, type ResumeBed } from "./testing/resume-bed.ts";

/*
 * M14 RT-03: a resume effect that comes due after the owner disabled the account reads `paused` from the real settings
 * service (the first chokepoint) and sends nothing, then goes on once the account is enabled.
 */
const MIN = 60_000;
const off = new Set<string>();
let dir: string;
let settings: SettingsPort;
let closeSettings: () => void;
let t: ResumeBed;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-resume-disabled-"));
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
  closeSettings = () => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  };
  t = openResumeBed({ createRunsService, createRunsStore, createResume });
});
afterEach(() => {
  t.close();
  closeSettings();
});

describe("a resume effect after the disable", () => {
  it("defers and sends nothing, then goes on once the account is enabled", async () => {
    Object.defineProperty(t.settings, "paused", { get: () => settings.automation("u1").paused });
    t.limitRun("You have hit your usage limit. Try again in ~1 min.");
    off.add("u1");
    await t.bed.clock.advance(MIN + 60_000);
    await t.outbox.drain();
    expect(t.sessions.prompts).toEqual([]);
    expect(t.row()).toMatchObject({ status: "pending", sent_at: null });
    off.delete("u1");
    await t.bed.clock.advance(5 * MIN);
    await t.outbox.drain();
    expect(t.sessions.prompts).toHaveLength(1);
  });
});
