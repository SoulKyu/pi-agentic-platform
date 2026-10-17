import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CliIo } from "../open-home.ts";
import { runCli } from "../run-cli.ts";
import { backupOf, craft, makeHome, NOW, PASSPHRASE, readRows } from "../testing/restore-kit.ts";
import { cliIo } from "../testing/cli-io.ts";
import { fakeSystemd } from "../testing/fake-systemd.ts";
import { restoreBackup, type RestoreDeps } from "./restore.ts";

let scratch: string;
let source: string;
let target: string;
let sourcePi: string;
let targetPi: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "pap-restore-"));
  source = join(scratch, "source");
  target = join(scratch, "target");
  sourcePi = join(scratch, "pi-source");
  targetPi = join(scratch, "pi-target");
  mkdirSync(join(sourcePi, "sessions", "proj"), { recursive: true });
  writeFileSync(join(sourcePi, "sessions", "proj", "s1.jsonl"), "from the backup");
  writeFileSync(join(sourcePi, "sessions", "proj", "s2.jsonl"), "second");
  mkdirSync(join(sourcePi, "sessions", "dir2"), { recursive: true });
  writeFileSync(join(sourcePi, "sessions", "dir2", "f.jsonl"), "under a file");
  makeHome(source, ["alpha", "beta"], {
    "agents/a/f.txt": "file",
    "agents/a/run.sh": "#!/bin/sh\n",
    "search.db": "cache",
    "secrets/vault/key": "VAULT-KEY",
    "secrets/push/vapid.json": '{"private":"VAPID"}',
  });
  chmodSync(join(source, "agents/a/run.sh"), 0o755);
  chmodSync(join(source, "agents/a/f.txt"), 0o644);
  const fake = fakeSystemd(join(scratch, "fake"));
  env = {
    PATH: `${fake.binDir}:${process.env.PATH}`,
    PAP_HOME: target,
    HOME: join(scratch, "user"),
    PI_CODING_AGENT_DIR: targetPi,
  };
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const deps = (file: string, over: Partial<RestoreDeps> = {}): RestoreDeps => ({
  home: target,
  piDir: targetPi,
  file,
  replace: false,
  now: NOW,
  passphrase: async () => PASSPHRASE,
  ...over,
});
const mode = (path: string): number => statSync(path).mode & 0o777;
const piped = (text: string): CliIo["stdin"] => Object.assign(Readable.from([text]), { isTTY: false });

describe("restoreBackup", () => {
  it("restores a plain backup into an empty home with owner-only modes, no search cache, and releases everything", async () => {
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file));
    expect(readRows(join(target, "state.db"))).toEqual(["alpha", "beta"]);
    expect(mode(join(target, "state.db"))).toBe(0o600);
    expect(readFileSync(join(target, "agents/a/f.txt"), "utf8")).toBe("file");
    expect(mode(join(target, "agents/a/f.txt"))).toBe(0o600);
    expect(mode(join(target, "agents/a/run.sh"))).toBe(0o700);
    expect(mode(join(target, "agents"))).toBe(0o700);
    expect(mode(join(target, "agents/a"))).toBe(0o700);
    expect(existsSync(join(target, "search.db"))).toBe(false);
    expect(existsSync(join(target, "secrets/vault/key"))).toBe(false);
    expect(readdirSync(join(target, "tmp"))).toEqual([]);
    expect(existsSync(join(target, "update", "op.lock"))).toBe(false);
    expect(existsSync(join(target, "pap.lock"))).toBe(false);
    expect(result.secretsRestored).toBe(false);
    expect(result.keptDatabase).toBeNull();
  });

  it("with --replace keeps the old database and the old folders under backups/pre-restore-*", async () => {
    makeHome(target, ["old row"], { "agents/old/keep.txt": "kept" });
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file, { replace: true }));
    expect(readRows(join(target, "state.db"))).toEqual(["alpha", "beta"]);
    expect(existsSync(join(target, "agents/old"))).toBe(false);
    expect(result.keptDatabase).toMatch(/backups\/pre-restore-20261017T120000Z\.db$/);
    expect(readRows(result.keptDatabase ?? "")).toEqual(["old row"]);
    expect(readFileSync(join(result.keptFolders ?? "", "agents/old/keep.txt"), "utf8")).toBe("kept");
  });

  it("adds missing Pi sessions, never overwrites a file, and skips a name whose parent is not a folder", async () => {
    mkdirSync(join(targetPi, "sessions", "proj"), { recursive: true });
    writeFileSync(join(targetPi, "sessions", "proj", "s1.jsonl"), "local copy, different");
    writeFileSync(join(targetPi, "sessions", "dir2"), "a file where the backup has a folder");
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file));
    expect(readFileSync(join(targetPi, "sessions", "proj", "s1.jsonl"), "utf8")).toBe(
      "local copy, different",
    );
    expect(readFileSync(join(targetPi, "sessions", "proj", "s2.jsonl"), "utf8")).toBe("second");
    expect(readFileSync(join(targetPi, "sessions", "dir2"), "utf8")).toBe(
      "a file where the backup has a folder",
    );
    expect(result.piAdded).toBe(1);
    expect(result.piSkipped).toBe(2);
    expect(readdirSync(scratch).filter((name) => name.startsWith("pi-target"))).toEqual(["pi-target"]);
  });

  it("never writes through a symbolic link in the Pi folder", async () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    mkdirSync(join(targetPi, "sessions"), { recursive: true });
    symlinkSync(outside, join(targetPi, "sessions", "proj"));
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file));
    expect(readdirSync(outside)).toEqual([]);
    expect(result.piAdded).toBe(1);
    expect(result.piSkipped).toBe(2);
  });

  it("skips every session when sessions itself is a symbolic link", async () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    mkdirSync(targetPi, { recursive: true });
    symlinkSync(outside, join(targetPi, "sessions"));
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file));
    expect(readdirSync(outside)).toEqual([]);
    expect(result.piAdded).toBe(0);
    expect(result.piSkipped).toBe(3);
  });

  it("a manifest that lists pi-agent whose sessions is a file restores without a Pi step", async () => {
    const file = craft(scratch, "nopi", {
      files: { "pi-agent/sessions": "x" },
      manifest: { tops: ["pi-agent"] },
    });
    const result = await restoreBackup(deps(file));
    expect(result.piAdded + result.piSkipped).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(readRows(join(target, "state.db"))).toEqual(["crafted"]);
  });

  it("a Pi folder that cannot be used skips the sessions with the reason instead of failing after the placement", async () => {
    writeFileSync(targetPi, "a file where the Pi folder belongs");
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file));
    expect(readRows(join(target, "state.db"))).toEqual(["alpha", "beta"]);
    expect(result.piAdded).toBe(0);
    expect(result.piSkipped).toBe(3);
    expect(result.piNote).toMatch(/Pi folder could not be prepared \((EEXIST|ENOTDIR)\)/);
  });

  it("a sessions path that is a file is skipped with its reason", async () => {
    mkdirSync(targetPi, { recursive: true });
    writeFileSync(join(targetPi, "sessions"), "x");
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await restoreBackup(deps(file));
    expect(result.piSkipped).toBe(3);
    expect(result.piNote).toBe("the sessions path of Pi is not a folder");
  });

  it("restores secrets from an encrypted backup at 0600, including the push key", async () => {
    const file = await backupOf(source, sourcePi, join(scratch, "out"), {
      encrypt: true,
      secrets: "include",
    });
    const result = await restoreBackup(deps(file));
    expect(result.secretsRestored).toBe(true);
    expect(result.vapidRestored).toBe(true);
    expect(readFileSync(join(target, "secrets/push/vapid.json"), "utf8")).toBe('{"private":"VAPID"}');
    expect(mode(join(target, "secrets/push/vapid.json"))).toBe(0o600);
    expect(mode(join(target, "secrets/push"))).toBe(0o700);
    expect(mode(join(target, "secrets/vault/key"))).toBe(0o600);
    expect(readdirSync(join(target, "tmp"))).toEqual([]);
  });

  it("asks for the passphrase only when the file is encrypted", async () => {
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const asked = { count: 0 };
    await restoreBackup(
      deps(file, {
        passphrase: async () => {
          asked.count++;
          return PASSPHRASE;
        },
      }),
    );
    expect(asked.count).toBe(0);
  });
});

describe("pap restore: the summary", () => {
  const run = async (args: string[], stdin?: string) => {
    const { io, stdout, stderr } = cliIo({
      env,
      homedir: join(scratch, "user"),
      now: NOW.getTime(),
      ...(stdin === undefined ? {} : { stdin: piped(stdin) }),
    });
    const code = await runCli(["restore", ...args], io);
    return { code, out: stdout(), err: stderr() };
  };

  it("for a plain backup names the home and its source, the missing secrets, the notifications line and the way to start pap", async () => {
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const { code, out, err } = await run([file]);
    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toContain(`home: ${target} (from the environment)`);
    expect(out).toContain("secrets: not restored");
    expect(out).toContain("re-enter agent secrets, rotate webhook secrets");
    expect(out).toContain("Notifications: each device re-enables when it next opens pap.");
    expect(out).toContain("Pi sessions: 3 added, 0 skipped");
    expect(out).toContain("start pap: systemctl --user start pap.service");
  });

  it("for an encrypted backup with secrets restores them and leaves out the notifications line", async () => {
    const file = await backupOf(source, sourcePi, join(scratch, "out"), {
      encrypt: true,
      secrets: "include",
    });
    const { code, out } = await run([file, "--passphrase-stdin"], `${PASSPHRASE}\n`);
    expect(code).toBe(0);
    expect(out).toContain("secrets: restored");
    expect(out).not.toContain("Notifications:");
    expect(out).not.toContain("re-enter agent secrets");
  });

  it("with --replace names the folders it kept and says the old data is there if the process is cut short", async () => {
    makeHome(target, ["old row"], { "agents/old/keep.txt": "kept" });
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const { code, out } = await run([file, "--replace"]);
    expect(code).toBe(0);
    expect(out).toContain(join(target, "backups", "pre-restore-20261017T120000Z.db"));
    expect(out).toContain(join(target, "backups", "pre-restore-20261017T120000Z"));
    expect(out).toContain("if the process is cut short");
  });

  it("names the reason in the summary when a sessions symbolic link skipped every session", async () => {
    const outside = join(scratch, "outside");
    mkdirSync(outside);
    mkdirSync(targetPi, { recursive: true });
    symlinkSync(outside, join(targetPi, "sessions"));
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const { out } = await run([file]);
    expect(out).toContain("Pi sessions: 0 added, 3 skipped");
    expect(out).toContain("the sessions folder of Pi is a symbolic link");
  });

  it("starts the unit it was given", async () => {
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const { out } = await run([file, "--unit", "pap-preview.service"]);
    expect(out).toContain("start pap: systemctl --user start pap-preview.service");
  });

  it("exits 64 with the usage on a missing file argument and 1 on the unit/home mismatch", async () => {
    expect((await run([])).code).toBe(64);
    const other = join(scratch, "service-home");
    const fake = fakeSystemd(join(scratch, "fake2"));
    fake.set("load-state", "loaded\n");
    fake.set(
      "cat-unit",
      `[Service]\nExecStart=/usr/bin/node /opt/pap/main.js serve\nEnvironment=PAP_HOME=${other}\n`,
    );
    env.PATH = `${fake.binDir}:${process.env.PATH}`;
    const file = await backupOf(source, sourcePi, join(scratch, "out"));
    const result = await run([file]);
    expect(result.code).toBe(1);
    expect(result.err).toContain(other);
    expect(existsSync(target)).toBe(false);
  });
});
