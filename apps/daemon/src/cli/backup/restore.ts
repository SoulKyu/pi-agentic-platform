import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  createReadStream,
  createWriteStream,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { freeMb as freeMegabytes } from "../../kernel/disk.ts";
import { acquireInstanceLock, prepareHome } from "../../kernel/home.ts";
import { acquireOpLock, OpLockBusy } from "../ops/op-lock.ts";
import { knownMigrationIds } from "../ops/schema-status.ts";
import { schemaIds } from "../ops/snapshot.ts";
import { pendingPath } from "../update/pending.ts";
import { BackupCryptoError, decryptFile } from "./crypto.ts";
import { ManifestSchema, type Manifest } from "./manifest.ts";
import { addPiSessions, type Counts } from "./pi-sessions.ts";
import { HOME_TOPS, PlaceError, placeRestored } from "./place.ts";
import { listMembers, RESTORE_LIMITS, UnsafeArchiveError, type Member } from "./tar-list.ts";
import { assertPlainTree, ownerOnly } from "./verify-stage.ts";

export class RestoreError extends Error {
  override name = "RestoreError";
}

export interface RestoreDeps {
  readonly home: string;
  readonly piDir: string;
  readonly file: string;
  readonly replace: boolean;
  readonly now: Date;
  /** Asked only when the file is encrypted. */
  readonly passphrase: () => Promise<string>;
  /** Free megabytes at a path, null when unknown; tests inject it. */
  readonly freeMb?: (path: string) => number | null;
  /** The reader of layer 1; tests stub it to prove the later layers refuse on their own. */
  readonly list?: (file: string) => Promise<readonly Member[]>;
}

export interface RestoreResult {
  readonly manifest: Manifest;
  /** The home folders placed, in `HOME_TOPS` order. */
  readonly tops: string[];
  readonly keptDatabase: string | null;
  readonly keptFolders: string | null;
  readonly secretsRestored: boolean;
  readonly vapidRestored: boolean;
  readonly piAdded: number;
  readonly piSkipped: number;
  /** Why every Pi session was skipped, when one reason covers them all. */
  readonly piNote: string | null;
  /** Things that did not stop the restore (a stage folder that could not be removed). */
  readonly warnings: string[];
}

const MIB = 1_048_576;
const DISK_MARGIN_MB = 64;
const MAX_MANIFEST_BYTES = 2 * MIB;
const MAGIC = Buffer.from("PAPB1\n", "latin1");
const FILES = new Set(["manifest.json", "state.db"]);
const ALLOWED_TOPS = new Set([...FILES, ...HOME_TOPS, "pi-agent"]);

/** One tar run is bounded: a hung read (a dead network mount) must not hold the locks for ever. */
const TAR_TIMEOUT_MS = 60 * 60_000;

const refuse = (message: string): never => {
  throw new RestoreError(message);
};

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
const isFile = (path: string): boolean => {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
};

/** `YYYYMMDDTHHMMSSZ`, the stamp of `pre-restore-<stamp>`. */
const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");

/** The input becomes a private copy inside the stage: a plain file is copied from one descriptor, an encrypted one is decrypted. */
async function privateCopy(deps: RestoreDeps, copy: string): Promise<{ size: number; encrypted: boolean }> {
  let fd: number;
  let encrypted = false;
  try {
    fd = openSync(deps.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP") return refuse("the backup path is a symbolic link: pass the file itself");
    if (code === "ENOENT") return refuse("no such backup file");
    return refuse(`the backup could not be opened (${code ?? "error"})`);
  }
  try {
    if (!fstatSync(fd).isFile()) refuse("the backup path is not a regular file");
    const head = Buffer.alloc(MAGIC.length);
    readSync(fd, head, 0, head.length, 0);
    if (head.equals(MAGIC)) {
      encrypted = true;
      try {
        await decryptFile(deps.file, copy, await deps.passphrase());
      } catch (error) {
        if (error instanceof BackupCryptoError) return refuse(error.message);
        throw error;
      }
    } else {
      await pipeline(
        createReadStream(deps.file, { fd, autoClose: false, start: 0 }),
        createWriteStream(copy, { flags: "wx", mode: 0o600 }),
      );
    }
  } catch (error) {
    if (error instanceof RestoreError) throw error;
    return refuse(`the backup could not be copied (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  } finally {
    closeSync(fd);
  }
  return { size: statSync(copy).size, encrypted };
}

/** The top-level names of the listing, after checking that they are only what a backup holds. */
function topsOf(members: readonly Member[]): Set<string> {
  const tops = new Set<string>();
  const seen = new Map<string, number>();
  for (const member of members) {
    const parts = member.path.split("/");
    const top = parts[0] ?? "";
    if (!ALLOWED_TOPS.has(top)) refuse("the backup holds a folder this pap does not restore");
    tops.add(top);
    if (parts.length === 1) seen.set(top, (seen.get(top) ?? 0) + 1);
    if (FILES.has(top) && (parts.length > 1 || member.kind !== "file"))
      refuse("the backup holds a file where a folder belongs, or the reverse");
    if (!FILES.has(top) && parts.length === 1 && member.kind !== "dir")
      refuse("the backup holds a file where a folder belongs, or the reverse");
    if (top === "pi-agent" && parts.length > 1 && parts[1] !== "sessions")
      refuse("the backup holds a folder this pap does not restore");
  }
  for (const name of FILES)
    if (seen.get(name) !== 1) refuse("the backup does not hold one manifest and one database");
  return tops;
}

/** Full extraction by GNU tar; the child is reaped before this returns and a non-zero exit refuses. */
async function extract(copy: string, tree: string): Promise<void> {
  const child = spawn(
    "tar",
    ["-xzf", copy, "-C", tree, "--no-same-owner", "--no-same-permissions", "--no-overwrite-dir"],
    {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: TAR_TIMEOUT_MS,
      killSignal: "SIGKILL",
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
    },
  );
  child.stderr.resume(); // it names paths the archive chose: drained, never shown
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exit) => resolve(exit ?? -1));
  }).catch(() => -2);
  if (code === -2) refuse("tar could not be run");
  if (code !== 0) refuse(`tar could not extract the backup (exit ${code})`);
}

function readManifest(tree: string): Manifest {
  const path = join(tree, "manifest.json");
  let parsed: unknown;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_MANIFEST_BYTES) throw new Error("not usable");
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return refuse("the backup manifest cannot be read");
  }
  const format = (parsed as { format?: unknown } | null)?.format;
  if (typeof format === "number" && Number.isInteger(format) && format !== 1)
    refuse(`the backup has format ${format}, which this pap does not know: it was written by a newer pap`);
  const checked = ManifestSchema.safeParse(parsed);
  if (!checked.success)
    return refuse("the backup manifest is not one this pap understands (a newer pap, or a damaged file)");
  return checked.data;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function verifyDatabase(tree: string, manifest: Manifest): Promise<void> {
  const db = join(tree, "state.db");
  if (!isFile(db)) refuse("the backup holds no database");
  if (statSync(db).size !== manifest.stateDb.bytes || (await sha256(db)) !== manifest.stateDb.sha256)
    refuse("the database in the backup does not match the checksum in its manifest");
  const ids = schemaIds(db);
  if (ids === null) return refuse("the database in the backup is damaged: nothing was restored");
  const known = knownMigrationIds();
  if (ids.some((id) => !known.has(id)))
    refuse("the database was written by a newer pap: upgrade pap first, nothing was restored");
  if (JSON.stringify([...ids].sort()) !== JSON.stringify([...manifest.schema].sort()))
    refuse("the manifest and the database disagree on the schema: nothing was restored");
}

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "error";

/** Removes the stage. A folder the archive made unreadable is chmodded u+rwx first, but only after lstat says it is a folder. */
function removeStage(stage: string): string | null {
  try {
    const pending = [stage];
    for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
      if (!lstatSync(dir).isDirectory()) continue;
      chmodSync(dir, 0o700);
      for (const name of readdirSync(dir)) {
        const child = join(dir, name);
        if (lstatSync(child).isDirectory()) pending.push(child);
      }
    }
    rmSync(stage, { recursive: true, force: true });
    return null;
  } catch {
    return `the restore stage ${stage} could not be removed: delete it by hand`;
  }
}

async function staged(deps: RestoreDeps, stage: string, warnings: string[]): Promise<RestoreResult> {
  const { home } = deps;
  const { size: copySize, encrypted } = await privateCopy(deps, join(stage, "input.tar.gz"));
  const copy = join(stage, "input.tar.gz");
  let members: readonly Member[];
  try {
    members = await (deps.list ?? ((file) => listMembers(file, RESTORE_LIMITS)))(copy);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) return refuse(error.message);
    return refuse(`the backup could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`);
  }
  const listed = topsOf(members);
  const declared = members.reduce((sum, member) => sum + (member.kind === "file" ? member.size : 0), 0);
  const neededMb = Math.ceil((declared + copySize) / MIB) + DISK_MARGIN_MB;
  const free = (deps.freeMb ?? ((path: string) => freeMegabytes(path)))(home);
  if (free !== null && free < neededMb)
    refuse(
      `not enough free space in ${home}: ${free} MB free, about ${neededMb} MB needed (the files in the backup, the copy of it and ${DISK_MARGIN_MB} MB)`,
    );

  const tree = join(stage, "tree");
  mkdirSync(tree, { mode: 0o700 });
  await extract(copy, tree);
  // Layer 3, then owner-only, with nothing reading an extracted file in between: a link in the tree must never reach a chmod.
  try {
    assertPlainTree(tree);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) return refuse(`the archive was not restored: ${error.message}`);
    throw error;
  }
  try {
    ownerOnly(tree);
  } catch (error) {
    if (error instanceof UnsafeArchiveError)
      return refuse(`the extracted files could not be made private: ${error.message}`);
    throw error;
  }

  const actual = new Set(readdirSync(tree));
  if (actual.size !== listed.size || [...actual].some((name) => !listed.has(name)))
    refuse("the extracted files differ from the listing of the archive");
  const manifest = readManifest(tree);
  if (listed.has("secrets") && manifest.secrets !== "included")
    refuse("the backup holds secrets that its manifest does not list");
  if (listed.has("secrets") && !encrypted)
    refuse(
      "the backup holds a secrets folder but is not encrypted: pap only writes secrets into an encrypted backup",
    );
  for (const top of listed)
    if (!FILES.has(top) && !(manifest.tops as readonly string[]).includes(top))
      refuse("the backup holds a folder that its manifest does not list");
  await verifyDatabase(tree, manifest);

  const tops = HOME_TOPS.filter((top) => listed.has(top));
  const secretsRestored = tops.includes("secrets");
  const vapidRestored = secretsRestored && isFile(join(tree, "secrets", "push", "vapid.json"));
  let kept: ReturnType<typeof placeRestored>;
  try {
    kept = placeRestored(home, tree, stamp(deps.now), tops);
  } catch (error) {
    if (error instanceof PlaceError) return refuse(error.message);
    throw error;
  }
  let pi: Counts | null = null;
  if (listed.has("pi-agent")) {
    try {
      pi = addPiSessions(join(tree, "pi-agent", "sessions"), deps.piDir);
    } catch (error) {
      warnings.push(`Pi sessions could not be restored (${codeOf(error)})`);
    }
  }
  return {
    manifest,
    tops: [...tops],
    keptDatabase: kept.keptDatabase,
    keptFolders: kept.keptFolders,
    secretsRestored,
    vapidRestored,
    piAdded: pi?.added ?? 0,
    piSkipped: pi?.skipped ?? 0,
    piNote: pi?.note ?? null,
    warnings,
  };
}

/**
 * Restores a backup into `home` (M6bR6a, in this order): `update/op.lock`, the home, the instance lock, the `--replace` check,
 * a private 0700 stage in `<home>/tmp`, a private copy of the input, the reader, the disk gate, `tar -x`, the stage walk,
 * owner-only modes, the manifest, the database, placement, Pi sessions. Each refusal is a fixed sentence and happens before
 * the next step; the stage and both locks are released on every path.
 */
export async function restoreBackup(deps: RestoreDeps): Promise<RestoreResult> {
  const { home } = deps;
  let releaseOp: () => void;
  try {
    releaseOp = acquireOpLock(home);
  } catch (error) {
    if (error instanceof OpLockBusy) return refuse(error.message);
    throw error;
  }
  try {
    prepareHome(home);
    const lock = acquireInstanceLock(home); // its error text is shown as it is
    try {
      if (exists(pendingPath(home)))
        refuse(
          "an update was interrupted (update/pending.json exists): run `pap update recover` first, or a later recover would replace the database you restore",
        );
      if (!deps.replace && exists(join(home, "state.db")))
        refuse(
          `state.db already exists in ${home}: pass --replace to restore over it (the current data is kept under backups/pre-restore-*)`,
        );
      mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
      const stage = mkdtempSync(join(home, "tmp", ".restore-"));
      const warnings: string[] = [];
      try {
        return await staged(deps, stage, warnings);
      } finally {
        const left = removeStage(stage);
        if (left !== null) warnings.push(left);
      }
    } finally {
      lock.release();
    }
  } finally {
    releaseOp();
  }
}
