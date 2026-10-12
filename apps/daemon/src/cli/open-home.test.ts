import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../daemon.ts";
import { createFakeClock } from "../kernel/clock.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { CliError, openHomeForCli } from "./open-home.ts";
import { cliIo } from "./testing/cli-io.ts";

let scratch: string;
let home: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-open-home-"));
  home = join(scratch, "home");
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function seed(extraApplied?: string): void {
  mkdirSync(home);
  const { db } = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(home, "backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  });
  if (extraApplied)
    db.run("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ($id, 'x', 1)", {
      id: extraApplied,
    });
  db.close();
}
const open = () => openHomeForCli(cliIo({ env: { PAP_HOME: home } }).io, { create: false });

describe("openHomeForCli", () => {
  it("opens a migrated home writable and releases the lock on close", async () => {
    seed();
    const opened = await open();
    expect(opened.home).toBe(home);
    expect(opened.db.readOnly).toBe(false);
    expect(existsSync(join(home, "pap.lock"))).toBe(true);
    opened.close();
    expect(existsSync(join(home, "pap.lock"))).toBe(false);
  });

  it("refuses a home written by a newer pap and releases the lock", async () => {
    seed("209912312359_future");
    const message = "the database was written by a newer pap; upgrade pap first";
    await expect(open()).rejects.toMatchObject({ name: "CliError", message });
    await expect(open()).rejects.toMatchObject({ name: "CliError", message });
    expect(existsSync(join(home, "pap.lock"))).toBe(false);
  });

  it("refuses a home without state.db when it may not create one, and creates nothing", async () => {
    await expect(open()).rejects.toEqual(new CliError(`no pap data in ${home}`));
    expect(existsSync(home)).toBe(false);
  });
});
