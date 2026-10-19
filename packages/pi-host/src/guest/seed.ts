import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, readdirSync, readFileSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { VmLayout } from "@pap/contracts";
import { openAt, openChain, openDirAt, openRootDir, renameAt, unlinkAt } from "../nofollow.ts";

const PUBLIC_FOLDER = 0o755;
const PRIVATE_FOLDER = 0o700;
const WRITE_NEW = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL;
const WRITE_FILE = constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC;

function writeFileAt(dirFd: number, name: string, data: Buffer, mode: number, flags = WRITE_FILE): void {
  const fd = openAt(dirFd, name, flags, mode);
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
      closeSync(openChain(rootFd, layout.root, folder, PUBLIC_FOLDER));
    }
    for (const folder of [layout.pi, layout.sessions]) {
      closeSync(openChain(rootFd, layout.root, folder, PRIVATE_FOLDER));
    }
    const agentFd = openChain(rootFd, layout.root, layout.piAgentDir, PRIVATE_FOLDER);
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
  const topFd = openRootDir("/");
  let imageFd = -1;
  let agentFd = -1;
  try {
    imageFd = openChain(topFd, "/", layout.imageAgentDir);
    agentFd = openChain(topFd, "/", layout.piAgentDir);
    const offered = readSettings(imageFd)?.packages;
    const wanted = new Set<unknown>(picks);
    const kept = Array.isArray(offered) ? offered.filter((entry) => wanted.has(sourceOf(entry))) : [];
    const settings = readSettings(agentFd) ?? {};
    const temp = `.settings.json.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
      writeFileAt(
        agentFd,
        temp,
        Buffer.from(`${JSON.stringify({ ...settings, packages: kept }, null, 2)}\n`),
        0o600,
        WRITE_NEW,
      );
      renameAt(agentFd, temp, "settings.json");
    } catch (error) {
      try {
        unlinkAt(agentFd, temp);
      } catch {
        // never created, or already renamed
      }
      throw error;
    }
  } finally {
    for (const fd of [imageFd, agentFd, topFd]) if (fd >= 0) closeSync(fd);
  }
}
