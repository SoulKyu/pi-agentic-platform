import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const KEY_BYTES = 32;

function readKey(file: string): Buffer | null {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== KEY_BYTES || (stat.mode & 0o077) !== 0) return null;
    const bytes = Buffer.alloc(KEY_BYTES);
    return readSync(fd, bytes, 0, KEY_BYTES, 0) === KEY_BYTES ? bytes : null;
  } finally {
    closeSync(fd);
  }
}

/**
 * AVM-E43 M4: the HMAC key of the plugin ids, 32 random bytes in `<papHome>/secrets/plugin-id.key` (0600), made once. A file
 * of another size, a link or one others can read is replaced (ids change, picks read as "no longer in your profile"). The
 * key is written whole to a temp file and linked into place, so a second helper never reads a half-made key.
 */
export function pluginIdKey(papHome: string): Buffer {
  const dir = join(papHome, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "plugin-id.key");
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = readKey(file);
    if (existing !== null) return existing;
    rmSync(file, { force: true });
    const fresh = randomBytes(KEY_BYTES);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, fresh, { flag: "wx", mode: 0o600 });
      linkSync(temp, file);
      return fresh;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  throw new Error("plugin id key");
}

/** AVM-E33: the id a package is known by outside the helper: a keyed hash of its scope and exact source, never the source itself. */
export const pluginIdOf = (key: Buffer, scope: "user" | "project", source: string): string =>
  createHmac("sha256", key).update(`pap-plugin\0${scope}\0${source}`).digest("hex").slice(0, 32);
