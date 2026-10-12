import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import { createKnownDevices, loadDeviceKey } from "./known-device.ts";

describe("known devices", () => {
  it("recognises its own cookie for the user it was issued to, and nothing else", () => {
    const devices = createKnownDevices(randomBytes(32));
    const cookie = devices.issue("u1");
    expect(cookie).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(devices.keyOf(cookie, "u1")).toMatch(/^device:[0-9a-f]{32}$/);
    expect(devices.keyOf(cookie, "u2")).toBeNull();
    expect(devices.keyOf(cookie, undefined)).toBeNull();
    expect(createKnownDevices(randomBytes(32)).keyOf(cookie, "u1")).toBeNull();
    const raw = Buffer.from(cookie, "base64url");
    raw[20] = (raw[20] ?? 0) ^ 1;
    expect(devices.keyOf(raw.toString("base64url"), "u1")).toBeNull();
    for (const bad of ["", "x", `${cookie}A`, cookie.slice(1), "%%%"])
      expect(devices.keyOf(bad, "u1")).toBeNull();
  });

  it("gives one device one stable key and two devices two keys, never the cookie itself", () => {
    const devices = createKnownDevices(randomBytes(32));
    const first = devices.issue("u1");
    const second = devices.issue("u1");
    expect(devices.keyOf(first, "u1")).toBe(devices.keyOf(first, "u1"));
    expect(devices.keyOf(first, "u1")).not.toBe(devices.keyOf(second, "u1"));
    expect(devices.keyOf(first, "u1")).not.toContain(first);
  });

  it("takes the first of several values that validates: a planted one in front changes nothing", () => {
    const devices = createKnownDevices(randomBytes(32));
    const cookie = devices.issue("u1");
    const planted = "A".repeat(43);
    expect(devices.keyOf([planted, "junk", cookie], "u1")).toBe(devices.keyOf(cookie, "u1"));
    expect(devices.keyOf([planted, "junk"], "u1")).toBeNull();
    expect(devices.keyOf([], "u1")).toBeNull();
    expect(devices.keyOf([cookie], "u2")).toBeNull();
    // Only the first few values are tried.
    expect(devices.keyOf([...Array<string>(16).fill(planted), cookie], "u1")).toBeNull();
  });

  it("refuses an absent cookie without throwing", () => {
    expect(createKnownDevices(randomBytes(32)).keyOf(undefined, "u1")).toBeNull();
  });
});

describe("the device key file", () => {
  let dir: string;
  let lines: string[];
  const logger = () =>
    createLogger({ level: "debug", clock: createFakeClock(), write: (line) => lines.push(line) });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pap-device-key-"));
    lines = [];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const path = () => join(dir, "device.key");

  it("is made once with 32 random bytes, mode 0600, and read back unchanged", () => {
    const key = loadDeviceKey(dir, logger());
    expect(key).toHaveLength(32);
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    expect(readFileSync(path())).toEqual(Buffer.from(key));
    expect(loadDeviceKey(dir, logger())).toEqual(key);
    expect(lines).toEqual([]);
  });

  it("replaces a file of another length, says so without the key, and keeps the new one", () => {
    writeFileSync(path(), "short", { mode: 0o600 });
    const key = loadDeviceKey(dir, logger());
    expect(key).toHaveLength(32);
    expect(readFileSync(path())).toEqual(Buffer.from(key));
    const [line] = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(line).toMatchObject({ level: "warn", msg: "device_key_replaced" });
    expect(lines.join("")).not.toContain(Buffer.from(key).toString("hex"));
    expect(lines.join("")).not.toContain(Buffer.from(key).toString("base64"));
    expect(loadDeviceKey(dir, logger())).toEqual(key);
  });

  it("replaces a key file that group or others can read: it may have leaked", () => {
    const key = loadDeviceKey(dir, logger());
    for (const mode of [0o640, 0o604, 0o644]) {
      chmodSync(path(), mode);
      lines.length = 0;
      const fresh = loadDeviceKey(dir, logger());
      expect(Buffer.from(fresh)).not.toEqual(Buffer.from(key));
      expect(statSync(path()).mode & 0o777).toBe(0o600);
      expect(readFileSync(path())).toEqual(Buffer.from(fresh));
      expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["device_key_replaced"]);
    }
  });

  it("replaces a symlink instead of following it", () => {
    const target = join(dir, "elsewhere");
    writeFileSync(target, randomBytes(32), { mode: 0o600 });
    symlinkSync(target, path());
    const key = loadDeviceKey(dir, logger());
    expect(Buffer.from(key)).not.toEqual(readFileSync(target));
    expect(statSync(path()).isFile()).toBe(true);
    expect(lines.map((l) => (JSON.parse(l) as { msg: string }).msg)).toEqual(["device_key_replaced"]);
  });

  it("makes the directory when it is missing", () => {
    const nested = join(dir, "secrets");
    expect(loadDeviceKey(nested, logger())).toHaveLength(32);
    expect(statSync(nested).mode & 0o777).toBe(0o700);
  });
});
