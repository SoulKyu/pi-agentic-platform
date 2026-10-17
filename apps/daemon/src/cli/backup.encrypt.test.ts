import { execFileSync } from "node:child_process";
import * as childProcess from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PassThrough, Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderSummary } from "./backup.ts";
import { decryptFile } from "./backup/crypto.ts";
import type { BackupResult } from "./backup/create.ts";
import type { CliIo } from "./open-home.ts";
import { runCli } from "./run-cli.ts";
import { cliIo } from "./testing/cli-io.ts";
import { fakeSystemd } from "./testing/fake-systemd.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const PASSPHRASE = "correct horse battery";
const KEY_BYTES = "VAULT-KEY-0123456789abcdef-MARKER";
const NAME = "pap-backup-20261017T100000Z.tar.gz";
const NOW = Date.UTC(2026, 9, 17, 10);

let scratch: string;
let home: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-backup-enc-"));
  home = join(scratch, "home");
  mkdirSync(join(home, "secrets", "vault"), { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "secrets", "push"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "secrets", "vault", "key"), KEY_BYTES, { mode: 0o600 });
  writeFileSync(join(home, "secrets", "push", "vapid.json"), '{"private":"VAPID-MARKER"}', { mode: 0o600 });
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", "notes.md"), "agent note");
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY)");
  db.exec("INSERT INTO schema_migrations VALUES ('kernel/202610100000_init.sql')");
  db.close();
  const fake = fakeSystemd(join(scratch, "fake"));
  env = { PATH: `${fake.binDir}:${process.env.PATH}`, PAP_HOME: home, HOME: join(scratch, "user") };
  vi.mocked(childProcess.spawn).mockClear();
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const piped = (text: string): CliIo["stdin"] => Object.assign(Readable.from([text]), { isTTY: false });

/** A terminal that types `lines` one per prompt, and keeps what was written to the screen. */
function terminal(lines: string[]) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => stdin });
  const screen: string[] = [];
  const stdout = {
    write: (text: string) => {
      screen.push(text);
      if (text.endsWith(": ")) stdin.write(`${lines.shift() ?? ""}\r`);
    },
  };
  return { stdin, screen, stdout };
}

async function run(args: string[], stdin: CliIo["stdin"] = piped(`${PASSPHRASE}\n`)) {
  const harness = cliIo({ env, homedir: join(scratch, "user"), now: NOW, stdin });
  const code = await runCli(["backup", ...args], harness.io);
  return { code, stdout: harness.stdout(), stderr: harness.stderr(), io: harness.io };
}

const backups = (): string[] => {
  try {
    return readdirSync(join(home, "backups"));
  } catch {
    return [];
  }
};

async function members(file: string): Promise<string[]> {
  const plain = join(scratch, "opened.tar.gz");
  rmSync(plain, { force: true });
  await decryptFile(file, plain, PASSPHRASE);
  return execFileSync("tar", ["-tzf", plain], { encoding: "utf8" }).split("\n").filter(Boolean);
}

describe("pap backup --encrypt", () => {
  it("refuses --secrets include without --encrypt (64), says why, and writes nothing", async () => {
    const { code, stderr } = await run(["--secrets", "include"]);
    expect(code).toBe(64);
    expect(stderr).toContain("--secrets include needs --encrypt");
    expect(stderr).toContain("plain file");
    expect(readdirSync(home).sort()).toEqual(["agents", "secrets", "state.db"]);
  });

  it.each([
    [["--secrets", "everything", "--encrypt"], "--secrets takes exclude or include"],
    [["--passphrase-stdin"], "--passphrase-stdin needs --encrypt"],
    [["--encrypt", "--secrets", "include", "x"], "backup takes no argument"],
    [["--encrypt", "--secrets"], "Option '--secrets <value>' argument missing"],
  ])("answers %j with exit 64 and writes nothing", async (args, message) => {
    const { code, stderr } = await run(args);
    expect(code).toBe(64);
    expect(stderr.split("\n")[0]).toBe(`pap: ${message}`);
    expect(backups()).toEqual([]);
  });

  it("includes secrets/ with --encrypt --secrets include: restoring takes the vault key and the push key at 0600", async () => {
    const { code, stdout } = await run(["--encrypt", "--secrets", "include", "--passphrase-stdin"]);
    expect(code).toBe(0);
    expect(backups()).toEqual([`${NAME}.enc`]);
    const file = join(home, "backups", `${NAME}.enc`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const listed = await members(file);
    expect(listed).toContain("secrets/vault/key");
    expect(listed).toContain("secrets/push/vapid.json");
    expect(listed).toContain("manifest.json");
    const verbose = execFileSync("tar", ["-tzvf", join(scratch, "opened.tar.gz")], { encoding: "utf8" });
    expect(verbose).toMatch(/^-rw-------.*secrets\/push\/vapid\.json$/m);
    expect(verbose).toMatch(/^drwx------.*secrets\/push\/$/m);
    const manifest = execFileSync("tar", ["-xzOf", join(scratch, "opened.tar.gz"), "manifest.json"], {
      encoding: "utf8",
    });
    expect(JSON.parse(manifest)).toMatchObject({ secrets: "included" });
    expect(manifest).not.toContain(PASSPHRASE);
    expect(stdout).toContain("secrets: included");
    expect(JSON.parse(readFileSync(join(home, "update", "last-backup.json"), "utf8"))).toMatchObject({
      file: `${NAME}.enc`,
      encrypted: true,
      secrets: "included",
    });
  });

  it("with --encrypt alone encrypts and still leaves the secrets folder out", async () => {
    const { code, stdout } = await run(["--encrypt"]);
    expect(code).toBe(0);
    const listed = await members(join(home, "backups", `${NAME}.enc`));
    expect(listed.some((member) => member.startsWith("secrets"))).toBe(false);
    expect(listed).toContain("agents/notes.md");
    expect(stdout).toContain("secrets: not included");
  });

  it("never leaves the key bytes, the plain tar or a stage in the output", async () => {
    await run(["--encrypt", "--secrets", "include"]);
    const file = join(home, "backups", `${NAME}.enc`);
    const raw = readFileSync(file);
    expect(raw.includes(Buffer.from(KEY_BYTES))).toBe(false);
    expect(raw.includes(Buffer.from("VAPID-MARKER"))).toBe(false);
    expect(raw.subarray(0, 6).toString("latin1")).toBe("PAPB1\n");
    expect(backups()).toEqual([`${NAME}.enc`]);
  });

  it("keeps the passphrase out of argv, of the tar process, of the output and of the manifest", async () => {
    const argvBefore = [...process.argv];
    const { stdout, stderr } = await run(["--encrypt", "--passphrase-stdin"]);
    expect(process.argv).toEqual(argvBefore);
    expect(process.argv.join(" ")).not.toContain(PASSPHRASE);
    const calls = vi.mocked(childProcess.spawn).mock.calls;
    expect(calls.filter(([command]) => command === "tar").length).toBe(1);
    expect(JSON.stringify(calls)).not.toContain(PASSPHRASE);
    expect(stdout + stderr).not.toContain(PASSPHRASE);
    const tarCall = calls.find(([command]) => command === "tar");
    expect(Object.keys((tarCall?.[2] as { env: object }).env).sort()).toEqual(["LC_ALL", "PATH"]);
  });

  it("takes only the first line of standard input", async () => {
    const { code } = await run(["--encrypt", "--passphrase-stdin"], piped(`${PASSPHRASE}\nsecond line\n`));
    expect(code).toBe(0);
    await members(join(home, "backups", `${NAME}.enc`));
  });

  it("refuses a passphrase under 12 characters before anything is written", async () => {
    const { code, stderr } = await run(["--encrypt", "--passphrase-stdin"], piped("short\n"));
    expect(code).toBe(1);
    expect(stderr).toBe("pap: the passphrase needs at least 12 characters\n");
    expect(readdirSync(home).sort()).toEqual(["agents", "secrets", "state.db"]);
  });

  it("refuses an empty standard input in the words of a passphrase", async () => {
    const { code, stderr } = await run(["--encrypt", "--passphrase-stdin"], piped(""));
    expect(code).toBe(1);
    expect(stderr).toBe("pap: no passphrase on standard input\n");
    expect(backups()).toEqual([]);
  });

  it("refuses a passphrase line that is too long in the words of a passphrase", async () => {
    const { code, stderr } = await run(["--encrypt", "--passphrase-stdin"], piped(`${"x".repeat(2000)}\n`));
    expect(code).toBe(1);
    expect(stderr).toBe("pap: the passphrase is too long\n");
  });

  it("on a terminal prompts twice, says pap cannot recover it, and writes the backup", async () => {
    const tty = terminal([PASSPHRASE, PASSPHRASE]);
    const harness = cliIo({ env, homedir: join(scratch, "user"), now: NOW, stdin: tty.stdin });
    const io = {
      ...harness.io,
      stdout: { write: (text: string) => (harness.io.stdout.write(text), tty.stdout.write(text)) },
    };
    expect(await runCli(["backup", "--encrypt"], io)).toBe(0);
    const screen = harness.stdout();
    expect(screen).toContain("This passphrase protects the backup file; pap cannot recover it.");
    expect(screen).toContain("Passphrase: ");
    expect(screen).toContain("Again: ");
    expect(screen).not.toContain(PASSPHRASE);
    await members(join(home, "backups", `${NAME}.enc`));
  });

  it("refuses --passphrase-stdin on a terminal with a hint, before reading anything", async () => {
    const tty = terminal([]);
    const { code, stderr, stdout } = await run(["--encrypt", "--passphrase-stdin"], tty.stdin);
    expect(code).toBe(64);
    expect(stderr.split("\n")[0]).toBe(
      "pap: --passphrase-stdin reads a pipe, and standard input is a terminal: omit the flag to use the prompt, or pipe the passphrase",
    );
    expect(stdout).toBe("");
    expect(backups()).toEqual([]);
  });

  it("on a terminal refuses two different entries and writes nothing", async () => {
    const tty = terminal([PASSPHRASE, `${PASSPHRASE}!`]);
    const harness = cliIo({ env, homedir: join(scratch, "user"), now: NOW, stdin: tty.stdin });
    const io = {
      ...harness.io,
      stdout: { write: (text: string) => (harness.io.stdout.write(text), tty.stdout.write(text)) },
    };
    expect(await runCli(["backup", "--encrypt"], io)).toBe(1);
    expect(harness.stderr()).toBe("pap: the two passphrases differ\n");
    expect(backups()).toEqual([]);
  });

  it("a wrong passphrase on restore side leaves no plain file", async () => {
    await run(["--encrypt"]);
    const file = join(home, "backups", `${NAME}.enc`);
    const out = join(scratch, "wrong.tar.gz");
    await expect(decryptFile(file, out, "another passphrase")).rejects.toThrow("wrong passphrase");
    expect(readdirSync(scratch)).not.toContain("wrong.tar.gz");
  });

  it("keeps older encrypted and plain backups apart under --keep", async () => {
    await run([]);
    const second = cliIo({
      env,
      homedir: join(scratch, "user"),
      now: NOW + 60_000,
      stdin: piped(`${PASSPHRASE}\n`),
    });
    expect(await runCli(["backup", "--encrypt", "--keep", "1"], second.io)).toBe(0);
    expect(backups().sort()).toEqual([NAME, "pap-backup-20261017T100100Z.tar.gz.enc"]);
  });
});

const result = (extra: Partial<BackupResult> = {}): BackupResult => ({
  path: "/data/backups/pap-backup-20261017T100000Z.tar.gz.enc",
  bytes: 1234,
  encrypted: true,
  tops: ["agents", "secrets"],
  skipped: { links: 0, names: 0, changed: 0 },
  examples: [],
  secretsIncluded: true,
  tarChanged: false,
  pruned: 0,
  ...extra,
});

describe("renderSummary for an encrypted backup", () => {
  const render = (extra: Partial<BackupResult>, secrets: "exclude" | "include") =>
    renderSummary({ result: result(extra), home: "/data", homeSource: "flag", skip: new Set(), secrets });

  it("says the file is encrypted, that the passphrase cannot be recovered and what the secrets line is", () => {
    const text = render({}, "include");
    expect(text).toContain("encrypted: yes (scrypt and AES-256-GCM). pap cannot recover a lost passphrase.");
    expect(text).toContain("secrets: included");
    expect(text).toContain("included: state.db, agents, secrets");
    expect(text).not.toContain("use --encrypt before copying");
    expect(text).not.toContain("secrets: not included");
    expect(text).toContain("copy this file off this machine");
  });

  it("encrypted without --secrets include says the secrets folder is left out", () => {
    const text = render({ secretsIncluded: false, tops: ["agents"] }, "exclude");
    expect(text).toContain("secrets: not included (use --secrets include)");
    expect(text).toContain("encrypted: yes");
  });

  it("include on an empty or missing secrets folder says nothing was there", () => {
    const text = render({ secretsIncluded: false, tops: ["agents"] }, "include");
    expect(text).toContain("secrets: requested, but the secrets folder is empty or absent");
  });

  it("a plain backup keeps its text", () => {
    const text = renderSummary({
      result: result({ encrypted: false, secretsIncluded: false, tops: ["agents"] }),
      home: "/data",
      homeSource: "flag",
      skip: new Set(),
      secrets: "exclude",
    });
    expect(text).toContain("secrets: not included (use --secrets include with --encrypt)");
    expect(text).toContain("use --encrypt before copying it off this machine");
    expect(text).not.toContain("encrypted: yes");
  });
});
