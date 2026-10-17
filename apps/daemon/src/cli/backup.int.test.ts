import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../kernel/clock.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { acquireInstanceLock } from "../kernel/home.ts";
import { silentLogger } from "../kernel/logger.ts";
import { MIGRATION_SOURCES } from "../daemon.ts";
import { fakeSystemd } from "./testing/fake-systemd.ts";
import { pap } from "./testing/pap.ts";

let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
let fake: ReturnType<typeof fakeSystemd>;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-backup-int-"));
  home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const { db } = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(home, "backups-migrate"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  });
  db.close();
  rmSync(join(home, "backups-migrate"), { recursive: true, force: true });
  mkdirSync(join(home, "agents", "a"), { recursive: true });
  writeFileSync(join(home, "agents", "a", "memory.md"), "m");
  fake = fakeSystemd(join(scratch, "fake"));
  env = {
    PATH: `${fake.binDir}:${process.env.PATH}`,
    PAP_HOME: home,
    HOME: join(scratch, "user"),
    PI_CODING_AGENT_DIR: join(scratch, "pi"),
  };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("pap backup (the real entry point)", () => {
  it("writes the archive, prints the summary and exits 0, even while another process holds the instance lock", () => {
    const lock = acquireInstanceLock(home);
    try {
      const run = pap(["backup"], env);
      expect(run.status).toBe(0);
      expect(run.stdout).toContain("The secrets folder is not included.");
      expect(run.stdout).toContain("copy this file off this machine");
      const files = readdirSync(join(home, "backups"));
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/^pap-backup-\d{8}T\d{6}Z\.tar\.gz$/);
      expect(statSync(join(home, "backups", files[0] ?? "")).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(join(home, "update", "last-backup.json"), "utf8")).file).toBe(files[0]);
    } finally {
      lock.release();
    }
  });

  it("refuses when the installed unit runs on another home, naming both, and writes no file", () => {
    const other = join(scratch, "service-home");
    fake.set("load-state", "loaded\n");
    fake.set(
      "cat-unit",
      `[Service]\nExecStart=/usr/bin/node /opt/pap/main.js serve\nEnvironment=PAP_HOME=${other}\n`,
    );
    const run = pap(["backup"], env);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(other);
    expect(run.stderr).toContain(home);
    expect(existsSync(join(home, "backups"))).toBe(false);
    expect(existsSync(join(home, "update"))).toBe(false);
  });

  it("exits 64 with the usage on a bad flag", () => {
    const run = pap(["backup", "--keep", "0"], env);
    expect(run.status).toBe(64);
    expect(run.stderr).toContain("pap backup [--out");
  });
});
