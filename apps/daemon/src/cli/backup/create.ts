import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { freeMb as freeMegabytes } from "../../kernel/disk.ts";
import { opsDir, writeJsonAtomic } from "../ops/paths.ts";
import { schemaIds, snapshotDatabase } from "../ops/snapshot.ts";
import { collect, type Collected } from "./collect.ts";
import { BackupCryptoError } from "./crypto.ts";
import { UnsafeArchiveError } from "./member-path.ts";
import { ManifestSchema, secretsAllowed, type Manifest } from "./manifest.ts";

export class BackupError extends Error {
  override name = "BackupError";
}

type Top = Manifest["tops"][number];
type Skippable = "attachments" | "agents" | "exports" | "pi";

export interface BackupDeps {
  readonly home: string;
  readonly piDir: string;
  readonly outDir: string;
  readonly now: Date;
  readonly papVersion: string;
  readonly secrets: "exclude" | "include";
  readonly skip: ReadonlySet<Skippable>;
  readonly allowLarge: boolean;
  /** Older `pap-backup-*` files of `outDir` to keep beside the new one. */
  readonly keep?: number;
  /** Plain archives only: reads the finished `.part` and throws when the restore would refuse it (T5a). */
  readonly selfCheck?: (file: string) => Promise<void>;
  /** Encrypts the tar stream into `outPath` (T4); the plaintext archive is never written. */
  readonly encrypt?: (plain: Readable, outPath: string) => Promise<void>;
  /** Free megabytes at a path, null when unknown; tests inject it. */
  readonly freeMb?: (path: string) => number | null;
  /** After SIGINT or SIGTERM removed the `.part` and the stage: ends the process by that signal (tests inject a spy). */
  readonly exitOnSignal?: (signal: NodeJS.Signals) => void;
}

export interface BackupResult {
  readonly path: string;
  readonly bytes: number;
  readonly encrypted: boolean;
  readonly tops: Top[];
  readonly skipped: { links: number; names: number; changed: number };
  readonly examples: string[];
  readonly secretsIncluded: boolean;
  /** GNU tar exited 1: a file changed while it was read. */
  readonly tarChanged: boolean;
  readonly pruned: number;
}

const MIB = 1_048_576;
const PAYLOAD_LIMIT = 2 * 1024 ** 3;
const DISK_MARGIN_MB = 64;
const BACKUP_NAME = /^pap-backup-\d{8}T\d{6}Z\.tar\.gz(\.enc)?$/;

/** GNU tar, no shell. Two lists (`\0`-separated, relative to their root), the Pi folder renamed on the way in. */
export const tarCreateArgs = (
  stage: string,
  home: string,
  homeList: string,
  piDir: string,
  piList: string,
): string[] => [
  "--format=pax",
  "--owner=0",
  "--group=0",
  "--numeric-owner",
  "--hard-dereference",
  "--no-recursion",
  "--create",
  "--gzip",
  "--file",
  "-",
  "-C",
  stage,
  "manifest.json",
  "state.db",
  "-C",
  home,
  "--null",
  "--files-from",
  homeList,
  "-C",
  piDir,
  "--transform",
  "s,^sessions,pi-agent/sessions,",
  "--null",
  "--files-from",
  piList,
];

const fsyncFile = (path: string): void => {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
};

async function sha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const stamp = (now: Date): string =>
  now
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");

function walk(root: string, top: string): Collected {
  try {
    return collect(root, top);
  } catch (error) {
    throw new BackupError(`cannot read ${top}: ${(error as Error).message}`);
  }
}

/** One tar run is bounded: a hung read (a dead network mount) must not hold the locks for ever. */
const TAR_TIMEOUT_MS = 60 * 60_000;

/** tar's stdout goes to the sink; its stderr is drained and never shown (it names paths). */
async function runTar(args: string[], sink: (stream: Readable) => Promise<void>): Promise<number> {
  const child = spawn("tar", args, {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: TAR_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" },
  });
  child.stderr.resume();
  const exit = new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? -1));
  });
  const [exited, written] = await Promise.allSettled([exit, sink(child.stdout)]);
  // The sink first: when it fails, tar only sees a closed pipe and exits with an error of its own.
  if (written.status === "rejected" && written.reason instanceof BackupCryptoError)
    throw new BackupError(written.reason.message); // fixed texts that never carry the passphrase
  if (written.status === "rejected")
    throw new BackupError(
      `the archive could not be written: ${(written.reason as NodeJS.ErrnoException).code ?? "error"}`,
    );
  if (exited.status === "rejected") throw new BackupError("tar could not be run");
  if (exited.value !== 0 && exited.value !== 1) throw new BackupError(`tar failed (exit ${exited.value})`);
  return exited.value;
}

/** A regular file; a name that vanished since the listing is not one. */
function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function prune(outDir: string, newest: string, keep: number, written: string): number {
  const older = readdirSync(outDir)
    .filter((name) => BACKUP_NAME.test(name) && name !== newest && isFile(join(outDir, name)))
    .sort();
  const doomed = older.slice(0, Math.max(0, older.length - keep));
  try {
    for (const name of doomed) rmSync(join(outDir, name), { force: true });
  } catch (error) {
    throw new BackupError(
      `the backup is written to ${written}, but removing an old one failed: ${(error as NodeJS.ErrnoException).code ?? "error"}`,
    );
  }
  return doomed.length;
}

/** `link` never replaces a file that appeared since the first check; a file system without hard links (FAT) falls back to `rename`. */
function publish(part: string, final: string, name: string, outDir: string): void {
  try {
    linkSync(part, final);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new BackupError(`${name} exists in ${outDir}: wait a second and run again`);
    renameSync(part, final);
    return;
  }
  rmSync(part, { force: true });
}

/**
 * One archive: `manifest.json`, a `state.db` snapshot, the home folders and Pi's `sessions/`. Nothing is written to
 * `outDir` until the payload and disk gates pass; the archive is built as `<name>.<pid>.<random>.part` (0600) and renamed on success,
 * and the `.part` and the stage folder are removed on any failure.
 */
export async function createBackup(deps: BackupDeps): Promise<BackupResult> {
  const { home, piDir, outDir } = deps;
  const encrypted = deps.encrypt !== undefined;
  if (deps.secrets === "include" && !encrypted)
    throw new BackupError("secrets can only be included in an encrypted backup (use --encrypt)");
  const withSecrets = secretsAllowed({ secrets: deps.secrets, encrypt: encrypted });
  const stateDb = join(home, "state.db");
  let dbBytes: number;
  try {
    dbBytes = statSync(stateDb).size;
  } catch {
    throw new BackupError(`no pap data in ${home}`);
  }
  const name = `pap-backup-${stamp(deps.now)}.tar.gz${encrypted ? ".enc" : ""}`;
  const final = join(outDir, name);
  try {
    lstatSync(final);
    throw new BackupError(`${name} exists in ${outDir}: wait a second and run again`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const optional = (["attachments", "agents", "exports"] as const).filter((top) => !deps.skip.has(top));
  const homeTops: Top[] = withSecrets ? [...optional, "secrets"] : optional;
  const walked = new Map<Top, Collected>();
  for (const top of homeTops) walked.set(top, walk(home, top));
  if (!deps.skip.has("pi")) walked.set("pi-agent", walk(piDir, "sessions"));
  const present = (["attachments", "agents", "exports", "secrets", "pi-agent"] as const).filter(
    (top) => (walked.get(top)?.entries.length ?? 0) > 0,
  );

  const payload = [...walked.values()].reduce((sum, found) => sum + found.bytes, 0);
  if (payload > PAYLOAD_LIMIT && !deps.allowLarge) {
    const sizes = [...walked].map(([top, found]) => `${top} ${(found.bytes / MIB).toFixed(1)} MiB`);
    throw new BackupError(
      `the payload is ${(payload / MIB).toFixed(1)} MiB, above 2 GiB (${sizes.join(", ")}): use --skip to leave a folder out or --allow-large to go on`,
    );
  }
  const freeAt = deps.freeMb ?? ((path: string) => freeMegabytes(path));
  const neededMb = Math.ceil((payload / 2 + dbBytes) / MIB) + DISK_MARGIN_MB;
  const free = freeAt(outDir);
  if (free !== null && free < neededMb)
    throw new BackupError(
      `not enough free space in ${outDir}: ${free} MB free, about ${neededMb} MB needed (half the payload, state.db and ${DISK_MARGIN_MB} MB)`,
    );
  // The stage holds a plain snapshot, the manifest and the member lists: it lives in the home (0700), never in `outDir`,
  // which may be removable or synced and is where an encrypted backup must stay the only readable-by-key file.
  const stageNeededMb = Math.ceil(dbBytes / MIB) + DISK_MARGIN_MB;
  const stageFree = freeAt(home);
  if (stageFree !== null && stageFree < stageNeededMb)
    throw new BackupError(
      `not enough free space in ${home}: ${stageFree} MB free, about ${stageNeededMb} MB needed (state.db and ${DISK_MARGIN_MB} MB)`,
    );

  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  mkdirSync(join(home, "tmp"), { recursive: true, mode: 0o700 });
  const stage = mkdtempSync(join(home, "tmp", ".backup-stage-"));
  const part = `${final}.${process.pid}.${randomBytes(4).toString("hex")}.part`;
  // Ctrl-C skips `finally`: without this the stage (a plain snapshot, also for an encrypted backup) and the .part stay behind.
  const onSignal = (signal: NodeJS.Signals): void => {
    rmSync(part, { force: true });
    rmSync(stage, { recursive: true, force: true });
    unwatch();
    (deps.exitOnSignal ?? ((sent) => process.kill(process.pid, sent)))(signal);
  };
  const unwatch = (): void => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    try {
      snapshotDatabase(stateDb, join(stage, "state.db"));
    } catch (error) {
      throw new BackupError(`state.db could not be copied (${(error as Error).message})`);
    }
    const ids = schemaIds(join(stage, "state.db"));
    if (ids === null) throw new BackupError("state.db is damaged or unreadable: nothing was backed up");
    const skipped = { links: 0, names: 0, changed: 0 };
    const examples: string[] = [];
    for (const found of walked.values()) {
      skipped.links += found.skippedLinks;
      skipped.names += found.skippedNames;
      skipped.changed += found.changed;
      examples.push(...found.examples);
    }
    const manifest = ManifestSchema.parse({
      format: 1,
      papVersion: deps.papVersion,
      createdAt: deps.now.toISOString(),
      schema: ids,
      stateDb: {
        sha256: await sha256(join(stage, "state.db")),
        bytes: statSync(join(stage, "state.db")).size,
      },
      secrets: withSecrets && present.includes("secrets") ? "included" : "excluded",
      tops: present,
      skipped,
    });
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const list = (tops: readonly Top[]): string =>
      tops
        .flatMap((top) => walked.get(top)?.entries ?? [])
        .map((entry) => `${entry}\0`)
        .join("");
    writeFileSync(join(stage, "home.list"), list(present.filter((top) => top !== "pi-agent")), {
      mode: 0o600,
    });
    writeFileSync(join(stage, "pi.list"), list(present.filter((top) => top === "pi-agent")), { mode: 0o600 });

    const args = tarCreateArgs(
      stage,
      home,
      join(stage, "home.list"),
      present.includes("pi-agent") ? piDir : stage,
      join(stage, "pi.list"),
    );
    const code = await runTar(args, (stream) =>
      deps.encrypt
        ? deps.encrypt(stream, part)
        : pipeline(stream, createWriteStream(part, { flags: "wx", mode: 0o600 })),
    );
    fsyncFile(part);
    if (!encrypted && deps.selfCheck) {
      try {
        await deps.selfCheck(part);
      } catch (error) {
        // the reader's sentences are fixed texts; any other error carries paths, so it is not shown
        throw new BackupError(
          `the archive failed its own check and was removed${error instanceof UnsafeArchiveError ? `: ${error.message}` : ""}`,
        );
      }
    }
    publish(part, final, name, outDir);
    try {
      writeJsonAtomic(join(opsDir(home), "last-backup.json"), {
        createdAt: manifest.createdAt,
        file: name,
        encrypted,
        secrets: manifest.secrets,
      });
    } catch (error) {
      throw new BackupError(
        `the backup is written to ${final}, but update/last-backup.json could not be (${(error as NodeJS.ErrnoException).code ?? "error"})`,
      );
    }
    return {
      path: final,
      bytes: statSync(final).size,
      encrypted,
      tops: present,
      skipped,
      examples: examples.slice(0, 5),
      secretsIncluded: manifest.secrets === "included",
      tarChanged: code === 1,
      pruned: deps.keep === undefined ? 0 : prune(outDir, name, deps.keep, final),
    };
  } catch (error) {
    rmSync(part, { force: true });
    throw error;
  } finally {
    unwatch();
    rmSync(stage, { recursive: true, force: true });
  }
}
