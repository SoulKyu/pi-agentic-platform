import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BoxRef } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock, type FakeClock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { KERNEL_MIGRATIONS, migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { AGENT_VM_MIGRATIONS, createLaunchRegistry } from "./index.ts";

const BOX: BoxRef = { kind: "project", id: "11111111-1111-4111-8111-111111111111" };
let dir: string;
let clock: FakeClock;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-launches-fwd-"));
  clock = createFakeClock();
  db = migrate({
    dbPath: join(dir, "state.db"),
    backupsDir: join(dir, "backups"),
    sources: [KERNEL_MIGRATIONS, AGENT_VM_MIGRATIONS],
    clock,
    logger: silentLogger,
  }).db;
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const make = () => createLaunchRegistry({ clock, db, logger: silentLogger });
const samples = (step: string) =>
  db.all<{ ms: number }>("SELECT ms FROM launch_steps WHERE step = :step", { step });

describe("steps only move forward (R7)", () => {
  it("a second opener on a live launch never moves a finished step back", async () => {
    const registry = make();
    const first = registry.open({ box: BOX, owner: "o", for: "s1" });
    first.step("checks", "running");
    await clock.advance(40);
    first.step("checks", "done");
    first.step("image", "running");
    first.step("image", "done");
    const second = registry.open({ box: BOX, owner: "o", for: "s2" });
    const before = registry.activeFor(BOX)?.steps;
    for (const state of ["running", "done", "skipped", "failed"] as const) {
      second.step("checks", state);
      second.step("image", state);
    }
    expect(registry.activeFor(BOX)?.steps).toEqual(before);
    expect(before?.find((s) => s.step === "checks")).toMatchObject({ state: "done" });
  });

  it("a joined launch writes one sample per step", async () => {
    const registry = make();
    const first = registry.open({ box: BOX, owner: "o", for: "s1" });
    const second = registry.open({ box: BOX, owner: "o", for: "s2" });
    for (const handle of [first, second]) {
      handle.step("checks", "running");
      await clock.advance(30);
      handle.step("checks", "done");
    }
    expect(samples("checks")).toEqual([{ ms: 30 }]);
  });
});
