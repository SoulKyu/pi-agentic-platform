import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../daemon.ts";
import { createFakeClock, type Clock } from "../kernel/clock.ts";
import { migrate } from "../kernel/db/migrate.ts";
import { silentLogger } from "../kernel/logger.ts";
import { bootTransport, createPushMeta, hostRules, loadVapid } from "../modules/push/index.ts";
import type { CliIo } from "./open-home.ts";
import { runCli } from "./run-cli.ts";
import { makeRelease } from "./testing/apply-harness.ts";
import { cliIo } from "./testing/cli-io.ts";
import { fakeSystemd } from "./testing/fake-systemd.ts";
import { pap } from "./testing/pap.ts";
import { readPending } from "./update/pending.ts";

/** The join's cross-lane checks: commands of lane 1 (backup, restore, doctor) and lane 2 (update) over one home. */

const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';
const ID = "0123456789abcdef0123456789abcdef";
const UNIT = "pap-join.service";

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
let userHome: string;
let papHome: string;
let app: string;

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
  scratch = mkdtempSync(join(tmpdir(), "pap-cross-lane-"));
  fake = fakeSystemd(join(scratch, "fake"));
  userHome = join(scratch, "user");
  papHome = join(scratch, "pap-home");
  app = join(scratch, "app");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(papHome, { recursive: true, mode: 0o700 });
  migrate({
    dbPath: join(papHome, "state.db"),
    backupsDir: join(scratch, "migrate-backups"),
    sources: MIGRATION_SOURCES,
    clock: createFakeClock(),
    logger: silentLogger,
  }).db.close();
  fake.set("linger", "yes\n");
  fake.set("invocation-id", `${ID}\n`);
  fake.set("active-state", "active\n");
  fake.set("restart-count", "0\n");
  fake.set("journal", `${LISTENING}\n`);
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const env = (): NodeJS.ProcessEnv => ({
  PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
  HOME: userHome,
  PAP_HOME: papHome,
  PAP_MIN_FREE_DISK_MB: "1",
  PI_CODING_AGENT_DIR: join(scratch, "pi"),
  LANG: "C.UTF-8",
});

describe("backup then doctor (T3 and T11)", () => {
  it("`pap backup` writes last-backup.json in the shape `doctor --only backup` reads: ok", () => {
    const made = pap(["backup"], env());
    expect(made.status, made.stderr).toBe(0);
    const checked = pap(["doctor", "--only", "backup"], env());
    expect(checked.stderr).toBe("");
    expect(checked.status).toBe(0);
    expect(checked.stdout).toMatch(/^\[ok\] backup /m);
  });
});

describe("backup, restore and doctor leave a plain home (T5b and T10)", () => {
  it("a restored home passes `doctor --only schema`, and neither step leaves a -wal or -shm", () => {
    const made = pap(["backup"], env());
    expect(made.status, made.stderr).toBe(0);
    const file = readdirSync(join(papHome, "backups")).find((name) => name.endsWith(".tar.gz"));
    const target = join(scratch, "restored");
    const restored = pap(["restore", join(papHome, "backups", file ?? ""), "--home", target], env());
    expect(restored.status, restored.stderr).toBe(0);
    const doctorEnv = { ...env(), PAP_HOME: target };
    const checked = pap(["doctor", "--only", "schema", "--home", target], doctorEnv);
    expect(checked.status, checked.stdout).toBe(0);
    expect(checked.stdout).toMatch(/^\[ok\] schema /m);
    expect(readdirSync(target).filter((name) => /-(wal|shm)$/.test(name))).toEqual([]);
  });
});

describe("an update that cannot restart (T6, T8, T10, T11)", () => {
  async function update(args: string[]) {
    fake.set(
      "cat-unit",
      `[Service]\nExecStart=/opt/node /opt/main.js serve\nEnvironment=PAP_HOME=${papHome}\n`,
    );
    const { io, stdout, stderr } = cliIo({ env: env(), homedir: userHome });
    const clocked: CliIo = { ...io, clock: steppingClock() };
    const code = await runCli(["update", ...args, "--unit", UNIT, "--app-root", app], clocked);
    return { code, out: stdout(), err: stderr() };
  }
  const doctor = (...args: string[]) => pap(["doctor", "--unit", UNIT, ...args], env());

  it("apply fails and the rollback cannot restart either: doctor fails with `pap update recover`, recover clears it, doctor is not a failure", async () => {
    makeRelease(app, "r1");
    makeRelease(app, "r2");
    execFileSync("ln", ["-s", "releases/r1", join(app, "current")]);
    fake.set("fail-restart", "");
    const failed = await update(["apply", "--release", "r2", "--settle-s", "0", "--deadline-s", "30"]);
    expect(failed.code, failed.err).toBe(5);
    expect(readPending(papHome)).not.toBeNull();

    const broken = doctor("--only", "update_pending");
    expect(broken.status).toBe(1);
    expect(broken.stdout).toMatch(/^\[fail\] update_pending /m);
    expect(broken.stdout).toContain("fix: pap update recover");

    rmSync(join(scratch, "fake", "answers", "fail-restart"));
    const recovered = await update(["recover"]);
    expect(recovered.code, recovered.err).toBe(0);
    expect(readPending(papHome)).toBeNull();

    const whole = doctor();
    expect([0, 2]).toContain(whole.status);
    expect(whole.stdout).not.toMatch(/^\[fail\]/m);
    expect(whole.stdout).toMatch(/^\[ok\] update_pending /m);
  });
});

describe("a plain restore over a home with its own push key (M12, T16 step 1)", () => {
  const migrated = (path: string) =>
    migrate({
      dbPath: join(path, "state.db"),
      backupsDir: join(scratch, "migrate-backups"),
      sources: MIGRATION_SOURCES,
      clock: createFakeClock(),
      logger: silentLogger,
    }).db;

  it("keeps the home's vapid.json, purges the subscriptions made under the backup's key at the next start and says devices re-enable", () => {
    // the source home has a device subscribed under the key of the backup
    const sub = new DatabaseSync(join(papHome, "state.db"));
    sub
      .prepare(
        "INSERT INTO push_subs (id, owner_id, credential_id, key_id, endpoint, endpoint_hash, p256dh, auth, locale, label, created_at) VALUES ('s1','u1','c1','oldkeyoldkeyold1','https://push.example/e1','h1','p','a','en','phone',1)",
      )
      .run();
    sub.close();
    const made = pap(["backup"], env());
    expect(made.status, made.stderr).toBe(0);
    const file = readdirSync(join(papHome, "backups")).find((name) => name.endsWith(".tar.gz"));

    // the target home already runs with its own key
    const target = join(scratch, "target");
    mkdirSync(target, { mode: 0o700 });
    migrated(target).close();
    expect(loadVapid(join(target, "secrets"), silentLogger).kind).toBe("ready");
    const ownKey = readFileSync(join(target, "secrets", "push", "vapid.json"), "utf8");

    const restored = pap(
      ["restore", join(papHome, "backups", file ?? ""), "--home", target, "--replace"],
      env(),
    );
    expect(restored.status, restored.stderr).toBe(0);
    expect(restored.stdout).toContain("Notifications: each device re-enables when it next opens pap.");
    expect(readFileSync(join(target, "secrets", "push", "vapid.json"), "utf8")).toBe(ownKey);

    // the next start of the daemon, as M12 boots it
    const db = migrated(target);
    try {
      const subscriptions = bootTransport({
        vapid: loadVapid(join(target, "secrets"), silentLogger),
        db,
        clock: createFakeClock(Date.UTC(2026, 9, 17)),
        logger: silentLogger,
        hosts: hostRules([]),
        loopbackForTests: false,
      });
      expect(subscriptions.countFor("u1")).toBe(0);
      expect(createPushMeta(db).keysReset()).toMatchObject({ purged: 1 });
    } finally {
      db.close();
    }
  });
});
