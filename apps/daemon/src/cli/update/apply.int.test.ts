import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttp, type Server } from "node:http";
import { createServer as createHttps } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATION_SOURCES } from "../../daemon.ts";
import { createFakeClock, type Clock } from "../../kernel/clock.ts";
import { migrate } from "../../kernel/db/migrate.ts";
import { silentLogger } from "../../kernel/logger.ts";
import type { CliIo } from "../open-home.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { makeRelease } from "../testing/apply-harness.ts";
import { cliIo } from "../testing/cli-io.ts";
import { pap } from "../testing/pap.ts";
import { makeApplyCommand } from "./apply-command.ts";
import { readPending } from "./pending.ts";

const LISTENING = '{"msg":"listening","url":"http://localhost:7777","port":7777}';
const BOOT = '{"msg":"boot"}';
const ID = "0123456789abcdef0123456789abcdef";

let scratch: string;
let fake: ReturnType<typeof fakeSystemd>;
let userHome: string;
let papHome: string;
let app: string;
const servers: Server[] = [];

/** Sleeping moves the clock and returns at once, so a 30 s deadline costs no time. */
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
  scratch = mkdtempSync(join(tmpdir(), "pap-apply-int-"));
  fake = fakeSystemd(join(scratch, "fake"));
  userHome = join(scratch, "user");
  papHome = join(scratch, "pap-home");
  app = join(scratch, "app");
  mkdirSync(userHome, { recursive: true });
  mkdirSync(papHome, { recursive: true, mode: 0o700 });
  makeRelease(app, "r1");
  makeRelease(app, "r2");
  execFileSync("ln", ["-s", "releases/r1", join(app, "current")]);
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
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
  rmSync(scratch, { recursive: true, force: true });
});

const unitText = (exec: string) =>
  `[Service]\nExecStart=/opt/node --disable-warning=ExperimentalWarning /opt/main.js serve${exec}\nEnvironment=PAP_HOME=${papHome}\n`;

const healthz = (server: Server, host = "127.0.0.1"): Promise<number> =>
  new Promise((resolve) => {
    servers.push(server);
    server.listen(0, host, () => resolve((server.address() as AddressInfo).port));
  });
const answer = (_req: unknown, res: { writeHead(code: number): void; end(body: string): void }): void => {
  res.writeHead(200);
  res.end('{"status":"ok"}');
};

/** The restart of the fake systemctl: the new release (r2) can fail to listen and migrate the database; the old one listens. */
function restartHook(newReleaseFails: boolean): void {
  const migrateScript = join(scratch, "migrate.cjs");
  writeFileSync(
    migrateScript,
    [
      "const { DatabaseSync } = require('node:sqlite');",
      "const db = new DatabaseSync(process.argv[2]);",
      "db.exec(\"INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('zzzz-next', 'x', 1)\");",
      "db.close();",
      "",
    ].join("\n"),
  );
  const answers = join(scratch, "fake", "answers");
  const hook = join(answers, "restart-hook");
  writeFileSync(
    hook,
    [
      "#!/bin/sh",
      `if [ "$(readlink '${join(app, "current")}')" = releases/r2 ] && [ ${newReleaseFails ? "1" : "0"} = 1 ]; then`,
      `  printf '%s\\n' '${BOOT}' > '${join(answers, "journal")}'`,
      `  '${process.execPath}' --disable-warning=ExperimentalWarning '${migrateScript}' '${join(papHome, "state.db")}'`,
      "else",
      `  printf '%s\\n' '${LISTENING}' > '${join(answers, "journal")}'`,
      "fi",
      "",
    ].join("\n"),
  );
  chmodSync(hook, 0o755);
}

async function apply(exec: string, extra: string[] = []) {
  fake.set("cat-unit", unitText(exec));
  const { io, stdout, stderr } = cliIo({
    env: { PATH: `${fake.binDir}:/usr/bin:/bin`, HOME: userHome },
    homedir: userHome,
  });
  const clocked: CliIo = { ...io, clock: steppingClock() };
  // the real wiring, systemd calls and health probe; only the guard looks at a neutral process (this suite may run inside pap's own unit)
  const cmd = makeApplyCommand({ readCgroup: () => "", ancestors: () => [] });
  const { values, positionals } = parseArgs({
    args: ["--release", "r2", "--app-root", app, ...extra],
    options: cmd.options,
    strict: true,
    allowPositionals: true,
  });
  const code = await cmd.run({ values, positionals, io: clocked });
  return { code, out: stdout(), err: stderr() };
}

const current = () => readlinkSync(join(app, "current"));
const verbs = () =>
  fake
    .calls()
    .filter((call) => /^systemctl --user (stop|reset-failed|restart) /.test(call))
    .map((call) => call.split(" ")[2]);
const migrationIds = (): string[] => {
  const db = new DatabaseSync(join(papHome, "state.db"), { readOnly: true });
  try {
    return (db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[]).map(
      (row) => row.id,
    );
  } finally {
    db.close();
  }
};

describe("pap update apply, over fake systemd and a real health server", () => {
  it("success: exit 0 and current names r2", async () => {
    restartHook(false);
    const port = await healthz(createHttp(answer));
    const result = await apply(` --port ${port}`);
    expect(result.code, result.err).toBe(0);
    expect(current()).toBe("releases/r2");
    expect(result.out).toContain("updated: r1 -> r2");
    expect(verbs()).toEqual(["stop", "reset-failed", "restart"]);
    expect(readPending(papHome)).toBeNull();
  });

  it("failure: the new release never listens and migrated: exit 4, r1 back, the pre-update database restored", async () => {
    restartHook(true);
    const before = migrationIds();
    const port = await healthz(createHttp(answer));
    const result = await apply(` --port ${port}`, ["--deadline-s", "30", "--settle-s", "0"]);
    expect(result.code, result.err).toBe(4);
    expect(current()).toBe("releases/r1");
    expect(verbs()).toEqual(["stop", "reset-failed", "restart", "stop", "reset-failed", "restart"]);
    expect(migrationIds()).toEqual(before);
    expect(result.err).toContain("the previous release (r1) is back and running");
    expect(result.err).toContain("were discarded");
    expect(readPending(papHome)).toBeNull();
  });

  it("an HTTPS unit with a certificate for another name is healthy (--tls-cert, RT-02)", async () => {
    restartHook(false);
    execFileSync(
      "openssl",
      [
        ...["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"],
        ...["-keyout", join(scratch, "k.pem"), "-out", join(scratch, "c.pem"), "-days", "1"],
        ...["-subj", "/CN=public.example"],
      ],
      { stdio: "ignore" },
    );
    const server = createHttps(
      { key: readFileSync(join(scratch, "k.pem")), cert: readFileSync(join(scratch, "c.pem")) },
      answer,
    );
    const port = await healthz(server);
    const result = await apply(
      ` --port ${port} --tls-cert ${join(scratch, "c.pem")} --tls-key ${join(scratch, "k.pem")}`,
    );
    expect(result.code, result.err).toBe(0);
    expect(current()).toBe("releases/r2");
  });

  it("a unit with --host 127.0.0.2 is probed there, not on 127.0.0.1 (RT-02)", async () => {
    restartHook(false);
    const port = await healthz(createHttp(answer), "127.0.0.2");
    const result = await apply(` --host 127.0.0.2 --port ${port}`);
    expect(result.code, result.err).toBe(0);
    expect(current()).toBe("releases/r2");
  });

  it("the guard refuses with the real unit name in the cgroup: no systemd call besides the unit read", async () => {
    restartHook(false);
    fake.set("cat-unit", unitText(" --port 1"));
    const { io, stderr } = cliIo({ env: { PATH: `${fake.binDir}:/usr/bin:/bin` }, homedir: userHome });
    const cmd = makeApplyCommand({ readCgroup: () => "0::/app.slice/pap.service\n", ancestors: () => [] });
    const { values, positionals } = parseArgs({
      args: ["--release", "r2", "--app-root", app],
      options: cmd.options,
      strict: true,
      allowPositionals: true,
    });
    await expect(cmd.run({ values, positionals, io })).rejects.toThrow(/SSH or console shell/);
    expect(stderr()).toBe("");
    expect(verbs()).toEqual([]);
    expect(current()).toBe("releases/r1");
  });
});

describe("the real entry point", () => {
  it("`pap update apply --help` prints one usage line and exits 0 (the installer's capability probe)", () => {
    const result = pap(["update", "apply", "--help"], { PATH: process.env.PATH ?? "", HOME: userHome });
    expect(result.status).toBe(0);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      "usage: pap update apply --release <id> [--app-root <abs>] [--deadline-s 30..600] [--settle-s 0..60] [--unit <name>]",
    ]);
  });
});
