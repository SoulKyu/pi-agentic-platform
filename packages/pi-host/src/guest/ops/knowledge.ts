import { closeSync, constants, readdirSync, writeSync } from "node:fs";
import { isOkfIndex, OKF_HEAD_BYTES, OKF_INDEX_TEXT, okfLogText } from "@pap/contracts/pi-host";
import { closeQuietly, openAt, openDirAt, openRootDir } from "../../nofollow.ts";
import { readAt } from "./fs-read.ts";
import { OpError, type OpEnv, opErrorOf } from "./paths.ts";

const FOLDER = "knowledge";
const MAX_CONCEPTS = 10_000;
const MAX_DEPTH = 16;
/** Directory entries one count may visit, concept or not. */
const MAX_ENTRIES = 50_000;
const CREATE = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;

const errno = (error: unknown): string | undefined => (error as NodeJS.ErrnoException).code;

/** Whether `index.md` in the folder is a regular file with `okf_version` in its first bytes; any failure reads as no. */
function isOkf(folder: number): boolean {
  let fd = -1;
  try {
    fd = openAt(folder, "index.md", constants.O_RDONLY);
    return isOkfIndex(readAt(fd, 0, OKF_HEAD_BYTES).toString("utf8"));
  } catch {
    return false;
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

function countConcepts(path: string, depth: number, budget: { concepts: number; entries: number }): void {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    budget.entries -= 1;
    if (budget.concepts <= 0 || budget.entries <= 0) return;
    if (entry.isDirectory()) {
      if (depth < MAX_DEPTH) countConcepts(`${path}/${entry.name}`, depth + 1, budget);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".md") &&
      entry.name !== "index.md" &&
      entry.name !== "log.md"
    )
      budget.concepts -= 1;
  }
}

/** `knowledge.state`: whether `knowledge/` is an OKF bundle (a regular `index.md` with `okf_version`) and how many concepts it holds. */
export function knowledgeState(env: OpEnv): { enabled: boolean; concepts: number } {
  const absent = { enabled: false, concepts: 0 };
  let root = -1;
  let folder = -1;
  try {
    root = openRootDir(env.project);
    folder = openDirAt(root, FOLDER);
    if (!isOkf(folder)) return absent;
    const budget = { concepts: MAX_CONCEPTS, entries: MAX_ENTRIES };
    try {
      countConcepts(`/proc/self/fd/${folder}`, 0, budget);
    } catch {
      // a folder that cannot be listed counts what it counted
    }
    return { enabled: true, concepts: MAX_CONCEPTS - budget.concepts };
  } catch {
    return absent;
  } finally {
    for (const fd of [folder, root]) if (fd >= 0) closeQuietly(fd);
  }
}

/** Creates `name` with `text` unless it exists; true when it was created. */
function createOnce(folder: number, name: string, text: string): boolean {
  let fd: number;
  try {
    fd = openAt(folder, name, CREATE, 0o644);
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
 * `knowledge.enable`: what the host's `enableKnowledge` writes. `knowledge/` must be a real folder (made here when missing)
 * and an `index.md` already there a regular file with `okf_version`: otherwise `conflict`, nothing written. Never overwrites.
 */
export function knowledgeEnable(env: OpEnv): { enabled: true } {
  let root = -1;
  let folder = -1;
  try {
    root = openRootDir(env.project);
    try {
      folder = openDirAt(root, FOLDER, { create: 0o755 });
    } catch (error) {
      // A link, a file or anything else in the folder's place.
      if (error instanceof Error && /is not a folder$/.test(error.message)) throw new OpError("conflict");
      throw error;
    }
    if (!createOnce(folder, "index.md", OKF_INDEX_TEXT) && !isOkf(folder)) throw new OpError("conflict");
    createOnce(folder, "log.md", okfLogText(new Date(env.now())));
    return { enabled: true };
  } catch (error) {
    throw opErrorOf(error);
  } finally {
    for (const fd of [folder, root]) if (fd >= 0) closeQuietly(fd);
  }
}
