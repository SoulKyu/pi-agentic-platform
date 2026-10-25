import { createHmac, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const KEY_BYTES = 32;

/** The key; `missing` (nothing there); or `damaged` with the identity of the file that was judged, so only that file is replaced. */
type Read = { key: Buffer } | { missing: true } | { damaged: { dev: number; ino: number } };

function readKey(file: string): Read {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { missing: true };
    const stat = lstatOrNull(file);
    return stat === null ? { missing: true } : { damaged: { dev: stat.dev, ino: stat.ino } };
  }
  try {
    const stat = fstatSync(fd);
    const bytes = Buffer.alloc(KEY_BYTES);
    return stat.isFile() &&
      stat.size === KEY_BYTES &&
      (stat.mode & 0o077) === 0 &&
      readSync(fd, bytes, 0, KEY_BYTES, 0) === KEY_BYTES
      ? { key: bytes }
      : { damaged: { dev: stat.dev, ino: stat.ino } };
  } finally {
    closeSync(fd);
  }
}

function lstatOrNull(file: string): Stats | null {
  try {
    return lstatSync(file);
  } catch {
    return null;
  }
}

/**
 * AVM-E43 M4: the HMAC key of the plugin ids, 32 random bytes in `<papHome>/secrets/plugin-id.key` (0600), made once. A file
 * of another size, a link or one others can read is replaced (ids change, picks read as "no longer in your profile"). The
 * key is written whole to a temp file and linked into place, so a second helper never reads a half-made key. S2 m1: a key
 * another creator linked meanwhile is never removed: a missing file is only linked into (EEXIST: the winner is read), and a
 * damaged one is removed only while it is still the very file that was judged.
 */
export function pluginIdKey(papHome: string, hooks: { afterRead?: () => void } = {}): Buffer {
  const dir = join(papHome, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "plugin-id.key");
  for (let attempt = 0; attempt < 3; attempt++) {
    const seen = readKey(file);
    if ("key" in seen) return seen.key;
    // The fresh key is written BEFORE the damaged file is judged and removed: its inode is allocated while that file still
    // exists, so it can never be the number the identity check compares (inode reuse, ABA, on ext4).
    const fresh = randomBytes(KEY_BYTES);
    const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
      writeFileSync(temp, fresh, { flag: "wx", mode: 0o600 });
      hooks.afterRead?.();
      if ("damaged" in seen) {
        const now = lstatOrNull(file);
        if (now !== null && now.dev === seen.damaged.dev && now.ino === seen.damaged.ino)
          rmSync(file, { force: true });
      }
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

type Scope = "user" | "project";

/** AVM-E33: the id of a package's exact source, a keyed hash of its scope and source, never the source itself. Picks saved before the identity ids hold these. */
export const pluginIdOf = (key: Buffer, scope: Scope, source: string): string =>
  createHmac("sha256", key).update(`pap-plugin\0${scope}\0${source}`).digest("hex").slice(0, 32);

/** The id of a package identity (its own domain: it never equals an exact source's id). */
const identityIdOf = (key: Buffer, scope: Scope, identity: string): string =>
  createHmac("sha256", key).update(`pap-plugin-identity\0${scope}\0${identity}`).digest("hex").slice(0, 32);

/** Pi's identity of a source, version and ref ignored; the exact source when Pi has no answer. */
export type IdentityOf = (source: string, scope: Scope) => string;

/**
 * Pi's own rule for "the same package" (`DefaultPackageManager.getPackageIdentity`, private in Pi's types, used by its update and
 * dedupe): `npm:name@1` and `npm:name@2` are one package, a git URL is its host and path. Without the method, or when it throws,
 * the exact source stands in (the ids of before).
 */
export function identityOf(pm: object): IdentityOf {
  const method: unknown = (pm as { getPackageIdentity?: unknown }).getPackageIdentity;
  return (source, scope) => {
    if (typeof method !== "function") return source;
    try {
      const identity: unknown = method.call(pm, source, scope);
      return typeof identity === "string" && identity.length > 0 ? identity : source;
    } catch {
      return source;
    }
  };
}

/**
 * The id each entry of one scope is listed under. The first entry of a package identity gets the identity's id, so a pick
 * survives a new version or ref in `settings.json`; a later entry of an identity already seen gets its exact source's id, so
 * two entries never share an id.
 */
export function pluginIdsOf(
  key: Buffer,
  scope: Scope,
  sources: readonly string[],
  identity: IdentityOf,
): string[] {
  const seen = new Set<string>();
  return sources.map((source) => {
    const id = identity(source, scope);
    if (seen.has(id)) return pluginIdOf(key, scope, source);
    seen.add(id);
    return identityIdOf(key, scope, id);
  });
}
