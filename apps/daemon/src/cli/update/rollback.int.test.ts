import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../../daemon.ts";
import { createFakeClock, type Clock } from "../../kernel/clock.ts";
import { migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { CliIo } from "../open-home.ts";
import { snapshotDatabase } from "../ops/snapshot.ts";
import { runCli } from "../run-cli.ts";
import { makeRelease } from "../testing/apply-harness.ts";
import { cliIo } from "../testing/cli-io.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { pap } from "../testing/pap.ts";
import { readPending, writePending } from "./pending.ts";

const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';
const ID = "0123456789abcdef0123456789abcdef";
const UNIT = "pap-t8.service";

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
let userHome: string;
let papHome: string;
let app: string;

/** Sleeping moves the clock and returns at once. */
function steppingClock(): Clock {
  const base = createFakeClock(Date.parse("2026-10-17T10:00:00.000Z"));
  let moved = 0;
  return {
    ...base,
    now: () => Date.parse("2026-10-17T10:00:00.000Z") + moved,
    sleep: async (ms) => {
      moved += ms;
    },
  };
}

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-rollback-int-"));
  fake = fakeSystemd(join(scratch, "fake"));
  userHome = join(scratch, "user");
  papHome = join(scratch, "pap-home");
  app = join(scratch, "app");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(papHome, { recursive: true, mode: 0o700 });
  makeRelease(app, "r1");
  makeRelease(app, "r2");
  execFileSync("ln", ["-s", "releases/r2", join(app, "current")]);
  migrate({
    dbPath: join(papHome, "state.db"),
    backupsDir: join(papHome, "backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  }).db.close();
  fake.set("invocation-id", `${ID}\n`);
  fake.set("active-state", "active\n");
  fake.set("restart-count", "0\n");
  fake.set("journal", `${LISTENING}\n`);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({ PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: userHome });
const ids = (): string[] => {
  const db = new DatabaseSync(join(papHome, "state.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]).map(
      (row) => row.id,
    );
  } finally {
    db.close();
  }
};
const verbs = (): string[] =>
  fake
    .calls()
    .filter((call) => /^systemctl --user (stop|reset-failed|restart) /.test(call))
    .map((call) => call.split(" ")[2] as string);

describe("the real entry point: usage and refusals exit with their codes", () => {
  it("update apply without --release exits 64", () => {
    const result = pap(["update", "apply"], env());
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("--release <id> is required");
  });

  it("update apply with no installed unit exits 1 and touches nothing", () => {
    const result = pap(["update", "apply", "--release", "r1", "--app-root", app], env());
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no installed unit");
    expect(verbs()).toEqual([]);
  });

  it("update rollback and update recover with no installed unit exit 1", () => {
    for (const command of ["rollback", "recover"]) {
      const result = pap(["update", command, "--app-root", app], env());
      expect(result.status, command).toBe(1);
      expect(result.stderr).toContain("no installed unit");
    }
    expect(verbs()).toEqual([]);
  });

  it("--help of both prints one usage line and exits 0 (no unit needed)", () => {
    for (const command of ["rollback", "recover"]) {
      const result = pap(["update", command, "--help"], env());
      expect(result.status, command).toBe(0);
      expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
      expect(result.stdout).toContain(`pap update ${command}`);
    }
  });

  it("both fall back to the usage on an unknown option", () => {
    expect(pap(["update", "rollback", "--nope"], env()).status).toBe(64);
    expect(pap(["update", "recover", "--nope"], env()).status).toBe(64);
  });
});

async function runThroughCli(args: string[]) {
  fake.set(
    "cat-unit",
    `[Service]\nExecStart=/opt/node /opt/main.js serve\nEnvironment=PAP_HOME=${papHome}\n`,
  );
  const { io, stdout, stderr } = cliIo({ env: env(), homedir: userHome });
  const clocked: CliIo = { ...io, clock: steppingClock() };
  const code = await runCli(["update", ...args, "--unit", UNIT, "--app-root", app], clocked);
  return { code, out: stdout(), err: stderr() };
}

describe("through runCli with fake systemd", () => {
  it("recover finishes an update cut after the migration: database restored, r1 current, journal gone", async () => {
    const snapshot = "pre-update-r2-2026-10-17T09-59-00-000Z.db";
    snapshotDatabase(join(papHome, "state.db"), join(papHome, "backups", snapshot));
    const db = new DatabaseSync(join(papHome, "state.db"));
    db.exec("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('zzzz-next', 'x', 1)");
    db.close();
    writePending(papHome, {
      format: 1,
      from: "r1",
      to: "r2",
      step: "started",
      snapshot,
      schemaBefore: ids().filter((id) => id !== "zzzz-next"),
      startedAt: "2026-10-17T09:59:00.000Z",
    });
    const result = await runThroughCli(["recover"]);
    expect(result.code, result.err).toBe(0);
    expect(readlinkSync(join(app, "current"))).toBe("releases/r1");
    expect(ids()).not.toContain("zzzz-next");
    expect(readPending(papHome)).toBeNull();
    expect(verbs()).toEqual(["stop", "reset-failed", "restart"]);
    expect(result.out).toContain("recovered");
  });

  it("rollback goes back to r1 and keeps the database that no migration touched", async () => {
    const snapshot = "pre-update-r2-2026-10-17T09-59-00-000Z.db";
    snapshotDatabase(join(papHome, "state.db"), join(papHome, "backups", snapshot));
    const result = await runThroughCli(["rollback"]);
    expect(result.code, result.err).toBe(0);
    expect(readlinkSync(join(app, "current"))).toBe("releases/r1");
    expect(verbs()).toEqual(["stop", "reset-failed", "restart"]);
    expect(result.out).toContain("rolled back: r2 -> r1");
  });
});
