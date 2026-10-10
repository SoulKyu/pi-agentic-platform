import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";

const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 64;
// Decision 34: at least 12 characters, counted after normalisation, so an accented letter is one character however it is typed.
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_UNITS = 1024;

export function isAcceptablePassword(password: string): boolean {
  return (
    password.length <= MAX_PASSWORD_UNITS &&
    Array.from(password.normalize("NFC")).length >= MIN_PASSWORD_LENGTH
  );
}

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password.normalize("NFC"), salt, KEY_LENGTH, options, (error, key) =>
      error ? reject(error) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return ["scrypt", PARAMS.N, PARAMS.r, PARAMS.p, salt.toString("base64url"), key.toString("base64url")].join(
    "$",
  );
}

// Total: a stored value that is malformed, from another scheme or beyond the memory cap is a mismatch, not a crash.
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, expected] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !expected) return false;
  try {
    const key = await scrypt(password, Buffer.from(salt, "base64url"), {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: PARAMS.maxmem,
    });
    const wanted = Buffer.from(expected, "base64url");
    return wanted.length === key.length && timingSafeEqual(wanted, key);
  } catch {
    return false;
  }
}

// Verified against when the account does not exist, so an unknown name costs the same time as a wrong password.
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword("pap-dummy-password-for-timing");
  return dummy;
}
