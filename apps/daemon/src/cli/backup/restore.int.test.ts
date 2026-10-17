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
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../../daemon.ts";
import { createFakeClock } from "../../kernel/clock.ts";
import { migrate } from "../../kernel/db/migrate.ts";
import { acquireInstanceLock } from "../../kernel/home.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { pap } from "../testing/pap.ts";
import { PASSPHRASE } from "../testing/restore-kit.ts";

let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-restore-int-"));
  home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const { db } = migrate({
    dbPath: join(home, "state.db"),
    backupsDir: join(scratch, "migrate-backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  });
  db.exec("CREATE TABLE int_probe (v TEXT); INSERT INTO int_probe VALUES ('one'), ('two')");
  db.close();
  rmSync(join(scratch, "migrate-backups"), { recursive: true, force: true });
  mkdirSync(join(home, "agents", "a"), { recursive: true });
  writeFileSync(join(home, "agents", "a", "memory.md"), "agent memory");
  mkdirSync(join(home, "secrets", "vault"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "secrets", "vault", "key"), "VAULT-KEY", { mode: 0o600 });
  const fake = fakeSystemd(join(scratch, "fake"));
  env = {
    PATH: `${fake.binDir}:${process.env.PATH}`,
    PAP_HOME: home,
    HOME: join(scratch, "user"),
    PI_CODING_AGENT_DIR: join(scratch, "pi"),
  };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const rowsOf = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT v FROM int_probe ORDER BY v").all() as { v: string }[]).map((row) => row.v);
  } finally {
    db.close();
  }
};

describe("pap backup then pap restore (the real entry point, encrypted, with secrets)", () => {
  it("rebuilds a deleted home: the database opens with the real migrate, rows and files are back", () => {
    const made = pap(
      ["backup", "--encrypt", "--secrets", "include", "--passphrase-stdin"],
      env,
      `${PASSPHRASE}\n`,
    );
    expect(made.status).toBe(0);
    const file = join(home, "backups", readdirSync(join(home, "backups"))[0] ?? "");
    const keep = join(scratch, "kept.tar.gz.enc");
    writeFileSync(keep, readFileSync(file));
    rmSync(home, { recursive: true });

    const wrong = pap(["restore", keep, "--passphrase-stdin"], env, "not the passphrase\n");
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toContain("wrong passphrase");
    expect(existsSync(join(home, "state.db"))).toBe(false);

    const run = pap(["restore", keep, "--passphrase-stdin"], env, `${PASSPHRASE}\n`);
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(run.stdout).toContain(`home: ${home} (from the environment)`);
    expect(run.stdout).toContain("secrets: restored");
    expect(rowsOf(join(home, "state.db"))).toEqual(["one", "two"]);
    expect(readFileSync(join(home, "agents", "a", "memory.md"), "utf8")).toBe("agent memory");
    expect(readFileSync(join(home, "secrets", "vault", "key"), "utf8")).toBe("VAULT-KEY");
    expect(statSync(join(home, "secrets", "vault", "key")).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "secrets", "vault")).mode & 0o777).toBe(0o700);

    const opened = migrate({
      dbPath: join(home, "state.db"),
      backupsDir: join(scratch, "after-backups"),
      sources: MIGRATION_SOURCES,
      clock: createFakeClock(),
      logger: silentLogger,
    });
    expect(opened.readOnly).toBe(false);
    expect(opened.applied).toEqual([]);
    opened.db.close();
    expect(existsSync(join(scratch, "after-backups"))).toBe(false);
  });

  it("exits 1 with `pap is already running` while another process holds the instance lock", () => {
    const made = pap(["backup"], env);
    expect(made.status).toBe(0);
    const file = join(home, "backups", readdirSync(join(home, "backups"))[0] ?? "");
    const lock = acquireInstanceLock(home);
    try {
      const run = pap(["restore", file, "--replace"], env);
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("pap is already running");
      expect(existsSync(join(home, "update", "op.lock"))).toBe(false);
    } finally {
      lock.release();
    }
  });
});
