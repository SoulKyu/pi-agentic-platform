import { closeSync, constants, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
import { join } from "node:path";

/** The owner's values pap knows: every key of `auth.json`, the vault's values, the Claude token, literal provider header values. */
export type KnownSecrets = ReadonlyArray<string>;

export const PROFILE_SECRET_NOTICE =
  "Un fichier du profil Pi contient un secret ; il n'entre pas dans l'image.";
/** The redactor's rule (`policy/redact.ts`): a value shorter than this is not a secret pap can tell from text. */
export const MIN_SECRET_LENGTH = 8;
export const SCAN_CHUNK_BYTES = 1024 * 1024;
const MAX_NEEDLES = 4096;
const WITHHELD = "[name withheld]";

/** Names the file, never the value. */
export class ProfileSecretError extends Error {
  readonly file: string;
  constructor(file: string) {
    super(`${PROFILE_SECRET_NOTICE} (${file})`);
    this.name = "ProfileSecretError";
    this.file = file;
  }
}

export interface TreeEntry {
  readonly rel: string;
  readonly kind: "file" | "dir" | "link" | "other";
  readonly mode: number;
}

/** Every entry under `root`, links not followed, in a stable order (names sorted, a folder before its content). */
export function walkTree(root: string, rel = ""): TreeEntry[] {
  const out: TreeEntry[] = [];
  const names = readdirSync(join(root, rel)).sort();
  for (const name of names) {
    const path = rel === "" ? name : `${rel}/${name}`;
    const stat = lstatSync(join(root, path));
    const kind = stat.isDirectory()
      ? "dir"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "link"
          : "other";
    out.push({ rel: path, kind, mode: stat.mode });
    if (kind === "dir") out.push(...walkTree(root, path));
  }
  return out;
}

function needlesOf(secrets: KnownSecrets): Buffer[] {
  const seen = new Set<string>();
  for (const value of secrets) {
    if (value.length < MIN_SECRET_LENGTH) continue;
    seen.add(value);
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) seen.add(escaped);
  }
  if (seen.size > MAX_NEEDLES) throw new RangeError("too many known secrets to scan for");
  return [...seen].map((value) => Buffer.from(value));
}

const holds = (haystack: Buffer, needles: readonly Buffer[]) =>
  needles.some((needle) => haystack.includes(needle));

function fileHolds(path: string, needles: readonly Buffer[], longest: number): boolean {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const chunk = Buffer.alloc(SCAN_CHUNK_BYTES);
    let carry: Buffer = Buffer.alloc(0);
    for (;;) {
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) return false;
      const window = Buffer.concat([carry, chunk.subarray(0, read)]);
      if (holds(window, needles)) return true;
      carry = Buffer.from(window.subarray(Math.max(0, window.length - (longest - 1))));
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Before a tag is computed: every file name, link target and file content under `root` is searched for every known
 * value (exact bytes, and the JSON-escaped form). A hit throws a `ProfileSecretError` that names the file.
 */
export function scanTree(root: string, secrets: KnownSecrets): void {
  const needles = needlesOf(secrets);
  if (needles.length === 0) return;
  const longest = Math.max(...needles.map((needle) => needle.length));
  for (const entry of walkTree(root)) {
    if (holds(Buffer.from(entry.rel), needles)) throw new ProfileSecretError(WITHHELD);
    const path = join(root, entry.rel);
    if (entry.kind === "link" && holds(Buffer.from(readlinkSync(path)), needles))
      throw new ProfileSecretError(entry.rel);
    if (entry.kind === "file" && fileHolds(path, needles, longest)) throw new ProfileSecretError(entry.rel);
  }
}
