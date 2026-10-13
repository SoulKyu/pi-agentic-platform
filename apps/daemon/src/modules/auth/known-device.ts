import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger } from "../../kernel/logger.ts";

export const DEVICE_COOKIE = "pap_device";
export const DEVICE_COOKIE_PATH = "/auth";
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 400 * 24 * 3600;

const KEY_FILE = "device.key";
const KEY_BYTES = 32;
const NONCE_BYTES = 16;
const MAC_BYTES = 16;
// A header can repeat the name (cookie tossing from a sibling path): only the first few values are tried.
const MAX_TRIED = 16;
const SHAPE = /^[A-Za-z0-9_-]{43}$/;
const LABEL = Buffer.from("pap-known-device");
const ZERO = Buffer.from([0]);

export interface KnownDevices {
  /** A new cookie value for a browser that just signed in as `userId`. */
  issue(userId: string): string;
  /**
   * The throttle key of a device this cookie was issued to for this user; null for anything else (absent, malformed,
   * forged, another key, another user). Given several values (a planted cookie can come first) the first that
   * validates counts. It only chooses a throttle key: it never authenticates anything.
   */
  keyOf(cookie: string | readonly string[] | undefined, userId: string | undefined): string | null;
}

export function createKnownDevices(key: Uint8Array): KnownDevices {
  const mac = (userId: string, nonce: Uint8Array) =>
    createHmac("sha256", key)
      .update(LABEL)
      .update(ZERO)
      .update(userId)
      .update(ZERO)
      .update(nonce)
      .digest()
      .subarray(0, MAC_BYTES);
  const keyOfOne = (cookie: string, userId: string): string | null => {
    if (!SHAPE.test(cookie)) return null;
    const raw = Buffer.from(cookie, "base64url");
    if (raw.length !== NONCE_BYTES + MAC_BYTES) return null;
    const nonce = raw.subarray(0, NONCE_BYTES);
    return timingSafeEqual(raw.subarray(NONCE_BYTES), mac(userId, nonce))
      ? `device:${nonce.toString("hex")}`
      : null;
  };
  return {
    issue(userId) {
      const nonce = randomBytes(NONCE_BYTES);
      return Buffer.concat([nonce, mac(userId, nonce)]).toString("base64url");
    },
    keyOf(cookie, userId) {
      if (cookie === undefined || userId === undefined) return null;
      if (typeof cookie !== "string") {
        for (const value of cookie.slice(0, MAX_TRIED)) {
          const key = keyOfOne(value, userId);
          if (key !== null) return key;
        }
        return null;
      }
      return keyOfOne(cookie, userId);
    },
  };
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "unknown";

/** The key file's bytes; null when missing. A symlink, a file of another size or one others can read gives no key. */
function readKeyFile(path: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    const code = codeOf(error);
    if (code === "ENOENT") return null;
    if (code === "ELOOP") return Buffer.alloc(0);
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    // A key that group or others could read may have leaked, and a leaked key mints unlimited cookies: replace it.
    if (!stat.isFile() || stat.size !== KEY_BYTES || (stat.mode & 0o077) !== 0) return Buffer.alloc(0);
    const bytes = Buffer.alloc(KEY_BYTES);
    if (readSync(fd, bytes, 0, KEY_BYTES, 0) !== KEY_BYTES) return Buffer.alloc(0);
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Creates the file only if nobody has (O_EXCL, 0600). False when it already exists. */
function createKeyFile(path: string, key: Buffer): boolean {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
  } catch (error) {
    if (codeOf(error) === "EEXIST") return false;
    throw error;
  }
  try {
    fchmodSync(fd, 0o600);
    writeSync(fd, key);
  } finally {
    closeSync(fd);
  }
  return true;
}

/**
 * The HMAC key of the known-device cookies: 32 random bytes in `secrets/device.key`, 0600. Made when missing; a file
 * of another length, a symlink or a file others can read is replaced, which forgets every known device, and logged. Never logged itself.
 */
export function loadDeviceKey(secretsDir: string, logger: Logger): Uint8Array {
  mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  const path = join(secretsDir, KEY_FILE);
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = readKeyFile(path);
    if (existing?.length === KEY_BYTES) return existing;
    if (existing !== null) {
      logger.warn("device_key_replaced", {});
      rmSync(path, { force: true });
    }
    const fresh = randomBytes(KEY_BYTES);
    if (createKeyFile(path, fresh)) return fresh;
  }
  throw new Error(`cannot create ${path}`);
}
