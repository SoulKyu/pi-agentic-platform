import { closeSync, constants, fchmodSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type { VmLayout } from "@pap/contracts";
import { closeQuietly, openAt, openDirAt, openRootDir } from "../nofollow.ts";

const PUBLIC_FOLDER = 0o755;
const PRIVATE_FOLDER = 0o700;
const WRITE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;

function componentsUnder(root: string, path: string): string[] {
  const rel = relative(root, path);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("the layout holds a folder outside its root");
  }
  return rel.split(sep);
}

/** Walks `path` below `root` one component at a time, each opened from its parent's descriptor, and returns the last. */
function openChain(rootFd: number, path: string, root: string, create: number): number {
  let current = rootFd;
  try {
    for (const name of componentsUnder(root, path)) {
      const next = openDirAt(current, name, { create });
      if (current !== rootFd) closeSync(current);
      current = next;
    }
  } catch (error) {
    if (current !== rootFd) closeQuietly(current);
    throw error;
  }
  return current;
}

function writeFileAt(dirFd: number, name: string, data: Buffer, mode: number): void {
  const fd = openAt(dirFd, name, WRITE_FILE, mode);
  try {
    for (let done = 0; done < data.length;) done += writeSync(fd, data, done);
    fchmodSync(fd, mode);
  } finally {
    closeSync(fd);
  }
}

function copyTree(source: string, destination: number): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.isDirectory()) {
      const child = openDirAt(destination, entry.name, { create: PRIVATE_FOLDER });
      try {
        copyTree(from, child);
      } finally {
        closeSync(child);
      }
    } else if (entry.isFile()) {
      // The image is read-only and ours; the disk side is where a link could have been planted.
      const executable = (statSync(from).mode & 0o100) !== 0;
      writeFileAt(destination, entry.name, readFileSync(from), executable ? 0o700 : 0o600);
    }
  }
}

/**
 * R28 (RT-07) and AVM-P5. Makes the layout folders a blank disk lacks (`home`, `knowledge`, `inbox` 0755; Pi's `.pi`,
 * `sessions` and agent folder 0700), then copies every file of the image's agent folder over Pi's: image-owned files are
 * replaced, files only Pi made are kept. Every component is opened from its parent's descriptor with O_NOFOLLOW, so a link
 * or a file where a folder belongs is refused and nothing is written through it. Throws on the first refusal.
 */
export function seedAgentFolder(layout: VmLayout): void {
  const rootFd = openRootDir(layout.root);
  try {
    for (const folder of [layout.home, layout.knowledge, layout.inbox]) {
      closeSync(openChain(rootFd, folder, layout.root, PUBLIC_FOLDER));
    }
    for (const folder of [layout.pi, layout.sessions]) {
      closeSync(openChain(rootFd, folder, layout.root, PRIVATE_FOLDER));
    }
    const agentFd = openChain(rootFd, layout.piAgentDir, layout.root, PRIVATE_FOLDER);
    try {
      copyTree(layout.imageAgentDir, agentFd);
    } finally {
      closeSync(agentFd);
    }
  } finally {
    closeSync(rootFd);
  }
}

interface PackageEntry {
  source?: unknown;
}
const sourceOf = (entry: unknown): unknown =>
  typeof entry === "string" ? entry : (entry as PackageEntry | null)?.source;

function readSettings(dirFd: number): Record<string, unknown> | null {
  let fd: number;
  try {
    fd = openAt(dirFd, "settings.json", constants.O_RDONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(fd, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("settings.json is not an object");
    }
    return parsed as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/**
 * RT-29. Sets `packages` in Pi's settings.json to the entries of the IMAGE's list whose source the agent picked (an entry
 * is a source string or an object with `source`), so a pick narrows the image's list and never adds to it, and a later
 * pick starts again from the image's list. `null` changes nothing. Pi's other settings are kept.
 */
export function pickPackages(layout: VmLayout, picks: string[] | null): void {
  if (picks === null) return;
  const imageFd = openRootDir(layout.imageAgentDir);
  const agentFd = openRootDir(layout.piAgentDir);
  try {
    const offered = readSettings(imageFd)?.packages;
    const wanted = new Set<unknown>(picks);
    const kept = Array.isArray(offered) ? offered.filter((entry) => wanted.has(sourceOf(entry))) : [];
    const settings = readSettings(agentFd) ?? {};
    writeFileAt(
      agentFd,
      "settings.json",
      Buffer.from(`${JSON.stringify({ ...settings, packages: kept }, null, 2)}\n`),
      0o600,
    );
  } finally {
    closeSync(imageFd);
    closeSync(agentFd);
  }
}
