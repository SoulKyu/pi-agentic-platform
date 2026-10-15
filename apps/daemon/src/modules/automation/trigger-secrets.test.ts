import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { newHookSecret } from "./hook-auth.ts";
import { readTriggerSecret, removeTriggerSecret, writeTriggerSecret } from "./trigger-secrets.ts";

const ID = "0b5e6f0e-2d0c-4a41-9a8e-3c1d2f4a5b6c";
let root: string;
let dir: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pap-secrets-"));
  dir = join(root, "secrets", "triggers");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const modeOf = (path: string): number => statSync(path).mode & 0o777;

describe("trigger secrets on disk", () => {
  it("writes the file 0600 in a 0700 folder and reads it back", () => {
    const secret = newHookSecret();
    writeTriggerSecret(dir, ID, secret);
    expect(modeOf(join(dir, `${ID}.key`))).toBe(0o600);
    expect(modeOf(dir)).toBe(0o700);
    expect(readTriggerSecret(dir, ID)).toBe(secret);
  });

  it("a rotation replaces the file and leaves no temporary file", () => {
    const first = newHookSecret();
    const second = newHookSecret();
    writeTriggerSecret(dir, ID, first);
    writeTriggerSecret(dir, ID, second);
    expect(readTriggerSecret(dir, ID)).toBe(second);
    expect(readdirSync(dir)).toEqual([`${ID}.key`]);
    expect(modeOf(join(dir, `${ID}.key`))).toBe(0o600);
  });

  it("refuses an id that is not a v4 UUID: a throw on write, null on read", () => {
    for (const id of ["../x", "x", ID.toUpperCase(), `${ID}/..`, "", `${ID}\0`]) {
      expect(() => writeTriggerSecret(dir, id, newHookSecret()), id).toThrow("bad trigger id");
      expect(readTriggerSecret(dir, id), id).toBeNull();
    }
    expect(existsSync(join(root, "x.key"))).toBe(false);
  });

  it("refuses to write a value that is not a webhook secret", () => {
    expect(() => writeTriggerSecret(dir, ID, "pwh_short")).toThrow("bad secret");
    expect(() => writeTriggerSecret(dir, ID, `${newHookSecret()}\n`)).toThrow("bad secret");
    expect(existsSync(dir)).toBe(false);
  });

  it("reads null when the file is missing", () => {
    expect(readTriggerSecret(dir, ID)).toBeNull();
  });

  it("reads null for a group-readable or world-readable file", () => {
    const secret = newHookSecret();
    writeTriggerSecret(dir, ID, secret);
    for (const mode of [0o640, 0o604, 0o644, 0o660]) {
      chmodSync(join(dir, `${ID}.key`), mode);
      expect(readTriggerSecret(dir, ID), mode.toString(8)).toBeNull();
    }
    chmodSync(join(dir, `${ID}.key`), 0o400);
    expect(readTriggerSecret(dir, ID)).toBe(secret);
  });

  it("reads null for a symbolic link, even to a private file holding a valid secret", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const target = join(root, "elsewhere.key");
    writeFileSync(target, newHookSecret(), { mode: 0o600 });
    symlinkSync(target, join(dir, `${ID}.key`));
    expect(readTriggerSecret(dir, ID)).toBeNull();
  });

  it("reads null for a FIFO and does not block on it", () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    execFileSync("mkfifo", ["-m", "600", join(dir, `${ID}.key`)]);
    // A blocking open() freezes the event loop, so vitest's timeout cannot fire: the read runs in a child that is
    // SIGKILLed after 10 s, and a regression fails here instead of hanging CI.
    const module = new URL("./trigger-secrets.ts", import.meta.url).href;
    const script = `
      const { readTriggerSecret } = await import(${JSON.stringify(module)});
      console.log(JSON.stringify({ secret: readTriggerSecret(process.env.PROBE_DIR, process.env.PROBE_ID) }));`;
    const { signal, stdout } = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", "--input-type=module", "-e", script],
      {
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
        env: { ...process.env, PROBE_DIR: dir, PROBE_ID: ID },
      },
    );
    expect({ signal, stdout: stdout.trim() }).toEqual({ signal: null, stdout: '{"secret":null}' });
  }, 20_000);

  it("reads null for a directory, a malformed content and an oversized file", () => {
    mkdirSync(join(dir, `${ID}.key`), { recursive: true, mode: 0o700 });
    expect(readTriggerSecret(dir, ID)).toBeNull();
    rmSync(join(dir, `${ID}.key`), { recursive: true });
    for (const content of [
      "",
      "pwh_short",
      `${newHookSecret()}\n`,
      `${newHookSecret()}x`,
      "x".repeat(129),
      "k".repeat(4096),
    ]) {
      writeFileSync(join(dir, `${ID}.key`), content, { mode: 0o600 });
      expect(readTriggerSecret(dir, ID), content.slice(0, 12)).toBeNull();
    }
  });

  it("a failed replacement leaves neither the new secret nor a temporary file behind", () => {
    mkdirSync(join(dir, `${ID}.key`, "occupied"), { recursive: true, mode: 0o700 });
    expect(() => writeTriggerSecret(dir, ID, newHookSecret())).toThrow();
    expect(readdirSync(dir)).toEqual([`${ID}.key`]);
  });

  it("removes the file, and removing a missing one is fine", () => {
    writeTriggerSecret(dir, ID, newHookSecret());
    removeTriggerSecret(dir, ID);
    expect(existsSync(join(dir, `${ID}.key`))).toBe(false);
    expect(() => removeTriggerSecret(dir, ID)).not.toThrow();
    expect(() => removeTriggerSecret(dir, "../x")).toThrow("bad trigger id");
  });
});
