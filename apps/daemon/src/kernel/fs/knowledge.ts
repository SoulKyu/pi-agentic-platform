import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { isOkfIndex, OKF_HEAD_BYTES, OKF_INDEX_TEXT, okfLogText, PapError } from "@pap/contracts";

const FOLDER = "knowledge";
const MAX_CONCEPTS = 10_000;
const MAX_DEPTH = 16;
/** Directory entries one count may visit, concept or not. */
const MAX_ENTRIES = 50_000;
const NOFOLLOW = constants.O_NOFOLLOW | constants.O_NOCTTY;
const OPEN_FILE = constants.O_RDONLY | NOFOLLOW | constants.O_NONBLOCK;
const OPEN_FOLDER = constants.O_RDONLY | NOFOLLOW | constants.O_DIRECTORY;
const CREATE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW;

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** A folder held open without following a link at its last name; null when it is anything else. */
function openFolder(path: string): number | null {
  try {
    return openSync(path, OPEN_FOLDER);
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errno(error) ?? "")) return null;
    throw error;
  }
}

/** Names inside an open folder resolve through its descriptor: a swap of the folder for a link cannot redirect them. */
const insideOf = (fd: number, name: string): string => join(`/proc/self/fd/${fd}`, name);

/** The first bytes of a regular file (no link followed); null for a link, a folder, a missing name or any refusal. */
function headOf(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FILE);
  } catch {
    return null;
  }
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buffer = Buffer.alloc(OKF_HEAD_BYTES);
    return buffer.toString("utf8", 0, readSync(fd, buffer, 0, OKF_HEAD_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

const isOkf = (head: string | null): boolean => head !== null && isOkfIndex(head);

function countConcepts(path: string, depth: number, budget: { concepts: number; entries: number }): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    budget.entries -= 1;
    if (budget.concepts <= 0 || budget.entries <= 0) return;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) countConcepts(join(path, entry.name), depth + 1, budget);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      entry.name !== "index.md" &&
      entry.name !== "log.md"
    )
      budget.concepts -= 1;
  }
}

/** Runs `read` on the open `knowledge/` folder when its `index.md` is an OKF index; any failure reads as absent. */
function withBundle<T>(
  root: string,
  absent: T,
  onError: ((code: string) => void) | undefined,
  read: (folder: number) => T,
): T {
  let folder: number | null = null;
  try {
    folder = openFolder(join(root, FOLDER));
    if (folder === null || !isOkf(headOf(insideOf(folder, "index.md")))) return absent;
    return read(folder);
  } catch (error) {
    onError?.(errno(error) ?? "unknown");
    return absent;
  } finally {
    if (folder !== null) closeSync(folder);
  }
}

/**
 * Whether `<root>/knowledge/index.md` is a regular file carrying `okf_version: "0.x"` in its first 512 bytes. Cheap
 * (no walk) and never throws: a folder pap cannot open reads as absent, `onError` gets the error code once per call.
 */
export function hasKnowledge(root: string, onError?: (code: string) => void): boolean {
  return withBundle<boolean>(root, false, onError, () => true);
}

/** `hasKnowledge` plus how many concept files the folder holds (bounded walk). Never throws. */
export function knowledgeOf(root: string): { enabled: boolean; concepts: number } {
  return withBundle<{ enabled: boolean; concepts: number }>(
    root,
    { enabled: false, concepts: 0 },
    undefined,
    (folder) => {
      const budget = { concepts: MAX_CONCEPTS, entries: MAX_ENTRIES };
      try {
        countConcepts(insideOf(folder, "."), 0, budget);
      } catch {
        // A folder that cannot be listed counts what it counted.
      }
      return { enabled: true, concepts: MAX_CONCEPTS - budget.concepts };
    },
  );
}

/** Creates `name` with `text` unless it exists; true when it was created. Exclusive: an existing name is never touched. */
function createOnce(folder: number, name: string, text: string): boolean {
  let fd: number;
  try {
    fd = openSync(insideOf(folder, name), CREATE_FILE, 0o644);
  } catch (error) {
    if (errno(error) === "EEXIST") return false;
    throw error;
  }
  try {
    writeSync(fd, text);
    return true;
  } finally {
    closeSync(fd);
  }
}

/**
 * Makes the project's OKF bundle: `knowledge/index.md` and `knowledge/log.md`, never overwriting a file. `knowledge`
 * must be a real folder (made here when missing; its parent must exist) and an `index.md` already there must be a
 * regular file with `okf_version`: otherwise `conflict`, with nothing written.
 */
export function enableKnowledge(root: string, now: Date): void {
  const path = join(root, FOLDER);
  try {
    mkdirSync(path, { mode: 0o755 });
  } catch (error) {
    if (errno(error) !== "EEXIST") throw error;
  }
  const folder = openFolder(path);
  if (folder === null) throw new PapError("conflict");
  try {
    if (!createOnce(folder, "index.md", OKF_INDEX_TEXT) && !isOkf(headOf(insideOf(folder, "index.md"))))
      throw new PapError("conflict");
    createOnce(folder, "log.md", okfLogText(now));
  } finally {
    closeSync(folder);
  }
}
