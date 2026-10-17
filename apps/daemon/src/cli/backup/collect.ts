import { lstatSync, readdirSync, type Stats } from "node:fs";
import { join } from "node:path";
import { safeMemberPath } from "./member-path.ts";

export interface Collected {
  /** Relative to the root they were collected from, folders first as the walk meets them. */
  readonly entries: string[];
  readonly bytes: number;
  readonly skippedLinks: number;
  readonly skippedNames: number;
  /** Entries that disappeared (or could not be listed) between the directory listing and the lstat: a live daemon deletes files. */
  readonly changed: number;
  /** The first few skipped paths, clipped, for the summary. */
  readonly examples: string[];
}

export interface WalkFs {
  lstat(path: string): Pick<Stats, "isDirectory" | "isFile" | "size"> & { readonly mode?: number };
  readdir(path: string): string[];
}

const realFs: WalkFs = { lstat: lstatSync, readdir: (path) => readdirSync(path) };
/** A pax `size` record is refused by the restore reader, so a file above the ustar limit (8 GiB - 1) could never be restored. */
const MAX_FILE = 8 * 1024 ** 3 - 1;
/** The restore reader refuses a path of more than this many parts and a folder without owner read and execute. */
const MAX_DEPTH = 128;
const gone = (error: unknown): boolean =>
  ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "");

/**
 * Walks `root/<top>` with lstat: folders and regular files only. A symbolic link, socket, FIFO or device is skipped and
 * counted (the restore reader refuses them); so is a name the restore reader would refuse (also a path deeper than 128 parts, and a folder without owner read and execute, with what is below it), which is checked BEFORE the lstat
 * (Node shows a name that is not UTF-8 as U+FFFD, and the lstat of that rebuilt path fails). Only a missing TOP is silent;
 * an entry that vanishes mid-walk is counted in `changed`, never a reason to stop and report success. Never follows a link,
 * never reads a file. `limit` stops a runaway tree.
 */
export function collect(root: string, top: string, limit = 1_000_000, fs: WalkFs = realFs): Collected {
  const entries: string[] = [];
  const examples: string[] = [];
  let bytes = 0;
  let skippedLinks = 0;
  let skippedNames = 0;
  let changed = 0;
  const note = (path: string): void => {
    if (examples.length < 5) {
      const plain = path.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "?"); // before clipping: a long name keeps no escape bytes
      examples.push(plain.length > 80 ? `${plain.slice(0, 77)}...` : plain);
    }
  };
  const visit = (relative: string, isTop: boolean): void => {
    try {
      safeMemberPath(relative);
      if (relative.split("/").length > MAX_DEPTH) throw new Error("too deep");
    } catch {
      skippedNames++;
      note(relative);
      return;
    }
    let stat: ReturnType<WalkFs["lstat"]>;
    try {
      stat = fs.lstat(join(root, relative));
    } catch (error) {
      if (!gone(error)) throw error;
      if (!isTop) {
        changed++;
        note(relative);
      }
      return;
    }
    if (!stat.isDirectory() && !stat.isFile()) {
      skippedLinks++;
      note(relative);
      return;
    }
    if (stat.isDirectory() && stat.mode !== undefined && (stat.mode & 0o500) !== 0o500) {
      skippedNames++; // the restore would refuse the folder: it could not be walked or removed
      note(relative);
      return;
    }
    if (stat.isFile() && stat.size > MAX_FILE)
      throw new Error(`a file above 8 GiB cannot be backed up: ${relative}`);
    if (entries.length >= limit) throw new Error("too many files");
    entries.push(relative);
    if (stat.isFile()) {
      bytes += stat.size;
      return;
    }
    let names: string[];
    try {
      names = fs.readdir(join(root, relative)).sort();
    } catch (error) {
      if (!gone(error)) throw error;
      changed++;
      note(relative);
      return;
    }
    for (const name of names) visit(`${relative}/${name}`, false);
  };
  visit(top, true);
  return { entries, bytes, skippedLinks, skippedNames, changed, examples };
}
