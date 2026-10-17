import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backup, renderSummary } from "./backup.ts";
import type { BackupResult } from "./backup/create.ts";
import { runCli } from "./run-cli.ts";
import { cliIo } from "./testing/cli-io.ts";
import { fakeSystemd } from "./testing/fake-systemd.ts";
import { rawHeader, writeGzTar } from "./testing/tar-fixtures.ts";

let scratch: string;
let home: string;
let fake: ReturnType<typeof fakeSystemd>;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-backup-cmd-"));
  home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  db.exec("INSERT INTO schema_migrations VALUES ('kernel/202610100000_init.sql')");
  db.close();
  fake = fakeSystemd(join(scratch, "fake"));
  env = { PATH: `${fake.binDir}:${process.env.PATH}`, PAP_HOME: home, HOME: join(scratch, "user") };
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const unitText = (papHome: string): string =>
  `[Service]\nExecStart=/usr/bin/node /opt/pap/main.js serve\nEnvironment=PAP_HOME=${papHome}\n`;

const result = (extra: Partial<BackupResult> = {}): BackupResult => ({
  path: "/data/backups/pap-backup-20261017T100000Z.tar.gz",
  bytes: 1234,
  encrypted: false,
  tops: ["attachments", "agents", "exports", "pi-agent"],
  skipped: { links: 0, names: 0, changed: 0 },
  examples: [],
  secretsIncluded: false,
  tarChanged: false,
  pruned: 0,
  ...extra,
});

const SENSITIVE =
  "The secrets folder is not included. Transcripts and agent files may still contain secrets: treat this file as sensitive, and use --encrypt before copying it off this machine.";

describe("renderSummary", () => {
  it("is a fixed text", () => {
    expect(
      renderSummary({
        result: result(),
        home: "/data",
        homeSource: "environment",
        skip: new Set(),
        secrets: "exclude",
      }),
    ).toBe(
      [
        "backup written: /data/backups/pap-backup-20261017T100000Z.tar.gz (1234 bytes)",
        "home: /data (from the environment)",
        "included: state.db, attachments, agents, exports, Pi sessions",
        "not included: search.db, worktrees, lanes, tmp, logs, backups, update, pap.lock, Pi auth.json, models.json and extensions",
        "secrets: not included (use --secrets include with --encrypt)",
        SENSITIVE,
        "copy this file off this machine: a backup on the same disk is not a backup",
        "",
      ].join("\n"),
    );
  });

  it("names what --skip left out, the skipped counts with examples, and the tar sentence", () => {
    const text = renderSummary({
      result: result({
        tops: ["exports"],
        skipped: { links: 2, names: 1, changed: 3 },
        examples: ["agents/link", "agents/bad?name"],
        tarChanged: true,
        pruned: 4,
      }),
      home: "/data",
      homeSource: "flag",
      skip: new Set(["pi", "agents"]),
      secrets: "exclude",
    });
    expect(text).toContain("home: /data (from the flag)");
    expect(text).toContain("included: state.db, exports");
    expect(text).toContain("left out by --skip: agents, pi");
    expect(text).toContain(
      "skipped: 2 symbolic links or special files, 1 names or folders the restore would refuse, 3 entries that changed during the backup (agents/link, agents/bad?name)",
    );
    expect(text).toContain(
      "Symbolic links, including those inside git working trees under agents/, are not in the backup.",
    );
    expect(text).toContain(
      "Files that changed during the backup may be incomplete (for example a transcript being written).",
    );
    expect(text).toContain("removed 4 older backups");
  });

  it("says nothing about links when there are none", () => {
    const text = renderSummary({
      result: result(),
      home: "/d",
      homeSource: "unit",
      skip: new Set(),
      secrets: "exclude",
    });
    expect(text).not.toContain("Symbolic links");
    expect(text).not.toContain("skipped:");
    expect(text).toContain("home: /d (from the unit)");
  });
});

describe("pap backup", () => {
  it("is in the command table and the usage", async () => {
    const { io, stderr } = cliIo();
    expect(await runCli(["nope"], io)).toBe(64);
    expect(stderr()).toContain(
      "pap backup [--out <abs dir>] [--skip <attachments|agents|exports|pi>]... [--allow-large] [--keep N] [--encrypt [--secrets include] [--passphrase-stdin]] [--unit <name>] [--home <abs dir>]",
    );
  });

  it("writes the archive to $PAP_HOME/backups and prints the summary", async () => {
    const { io, stdout } = cliIo({ env, homedir: join(scratch, "user"), now: Date.UTC(2026, 9, 17, 10) });
    expect(await runCli(["backup"], io)).toBe(0);
    expect(readdirSync(join(home, "backups"))).toEqual(["pap-backup-20261017T100000Z.tar.gz"]);
    expect(stdout()).toContain(`home: ${home} (from the environment)`);
    expect(stdout()).toContain(SENSITIVE);
    expect(stdout()).toContain("copy this file off this machine");
  });

  it("checks its own plain file with the restore reader and removes it when the reader refuses", async () => {
    writeGzTar(join(scratch, "hostile.tgz"), [
      rawHeader({ name: "agents/link", type: "2", linkname: "/etc" }),
    ]);
    mkdirSync(join(scratch, "shim"));
    const shim = join(scratch, "shim", "tar");
    writeFileSync(shim, `#!/bin/sh\ncat ${join(scratch, "hostile.tgz")}\n`, { mode: 0o755 });
    vi.stubEnv("PATH", `${join(scratch, "shim")}:${process.env.PATH ?? ""}`);
    const { io, stderr } = cliIo({ env, homedir: join(scratch, "user"), now: Date.UTC(2026, 9, 17, 10) });
    expect(await runCli(["backup"], io)).toBe(1);
    expect(stderr()).toContain(
      "the archive failed its own check and was removed: the archive holds a link, a device or another special member",
    );
    expect(readdirSync(join(home, "backups"))).toEqual([]);
  });

  it.each([
    [["--keep", "0"]],
    [["--keep", "101"]],
    [["--keep", "x"]],
    [["--keep", "1.5"]],
    [["--skip", "secrets"]],
    [["--skip", "pi", "--skip", "nope"]],
    [["--out", "relative/dir"]],
    [["--home", "relative"]],
    [["extra"]],
    [["--unit", "Bad Name"]],
    [["--bogus"]],
  ])("answers %j with exit 64 and writes nothing", async (args) => {
    const { io, stderr } = cliIo({ env, homedir: join(scratch, "user") });
    expect(await runCli(["backup", ...args], io)).toBe(64);
    expect(stderr()).toContain("pap: ");
    expect(readdirSync(home)).toEqual(["state.db"]);
  });

  it("refuses an installed unit on another home when --home is not given", async () => {
    const other = join(scratch, "service-home");
    fake.set("load-state", "loaded\n");
    fake.set("cat-unit", unitText(other));
    const { io, stderr } = cliIo({ env, homedir: join(scratch, "user") });
    expect(await runCli(["backup"], io)).toBe(1);
    expect(stderr()).toContain(other);
    expect(stderr()).toContain(home);
    expect(readdirSync(home)).toEqual(["state.db"]);
  });

  it("proceeds with --home even when the unit differs", async () => {
    fake.set("load-state", "loaded\n");
    fake.set("cat-unit", unitText(join(scratch, "service-home")));
    const { io, stdout } = cliIo({ env: { ...env, PAP_HOME: undefined }, homedir: join(scratch, "user") });
    expect(await runCli(["backup", "--home", home], io)).toBe(0);
    expect(stdout()).toContain(`home: ${home} (from the flag)`);
  });

  it("takes the unit's home when no PAP_HOME is set and says so", async () => {
    fake.set("load-state", "loaded\n");
    fake.set("cat-unit", unitText(home));
    const { io, stdout } = cliIo({ env: { ...env, PAP_HOME: undefined }, homedir: join(scratch, "user") });
    expect(await runCli(["backup"], io)).toBe(0);
    expect(stdout()).toContain(`home: ${home} (from the unit)`);
  });

  it("asks systemctl about the unit named by --unit", async () => {
    const { io } = cliIo({ env, homedir: join(scratch, "user") });
    await runCli(["backup", "--unit", "pap-preview.service"], io);
    expect(fake.calls().some((call) => call.includes("pap-preview.service"))).toBe(true);
  });

  it("refuses a unit whose text pap cannot read, unless --home is given", async () => {
    fake.set("load-state", "loaded\n");
    fake.set(
      "cat-unit",
      `[Service]\nExecStart=/usr/bin/node /opt/pap/main.js serve\nEnvironment="PAP_HOME=/x"\n`,
    );
    const refused = cliIo({ env, homedir: join(scratch, "user") });
    expect(await runCli(["backup"], refused.io)).toBe(1);
    expect(refused.stderr()).toContain("not a unit pap wrote");
    expect(readdirSync(home)).toEqual(["state.db"]);
    const given = cliIo({ env, homedir: join(scratch, "user") });
    expect(await runCli(["backup", "--home", home], given.io)).toBe(0);
  });

  it("falls back to the unit file when systemctl is not usable", async () => {
    const other = join(scratch, "service-home");
    const user = join(scratch, "user");
    mkdirSync(join(user, ".config", "systemd", "user"), { recursive: true });
    writeFileSync(join(user, ".config", "systemd", "user", "pap.service"), unitText(other));
    const { io, stderr } = cliIo({ env: { ...env, PATH: "/nonexistent" }, homedir: user });
    expect(await runCli(["backup"], io)).toBe(1);
    expect(stderr()).toContain(other);
  });

  it("refuses a home without state.db", async () => {
    rmSync(join(home, "state.db"));
    const { io, stderr } = cliIo({ env, homedir: join(scratch, "user") });
    expect(await runCli(["backup"], io)).toBe(1);
    expect(stderr()).toBe(`pap: no pap data in ${home}\n`);
  });

  it("prints the usage on a bad --keep", async () => {
    const { io, stderr } = cliIo({ env, homedir: join(scratch, "user") });
    expect(await runCli(["backup", "--keep", "0"], io)).toBe(64);
    expect(stderr()).toContain("pap backup [--out");
  });

  it("exports the command for the table", () => {
    expect(Object.keys(backup.options).sort()).toEqual([
      "allow-large",
      "encrypt",
      "home",
      "keep",
      "out",
      "passphrase-stdin",
      "secrets",
      "skip",
      "unit",
    ]);
  });
});
