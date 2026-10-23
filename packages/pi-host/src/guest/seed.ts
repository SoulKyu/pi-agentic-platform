import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { OKF_INDEX_TEXT, okfLogText, type VmLayout } from "@pap/contracts";
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

/**
 * AVM-E26: a link of the image (T14a keeps those whose target stays inside the package) is copied as a relative link
 * when its target, resolved, stays inside the image's agent folder; any other link is refused.
 */
function copyLink(from: string, imageRoot: string, destination: number, name: string): void {
  let real: string;
  try {
    real = realpathSync(from);
  } catch {
    throw new Error(`${name} is a link that does not resolve`);
  }
  const rel = relative(imageRoot, real);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`${name} is a link that leaves the image`);
  const target = relative(realpathSync(join(from, "..")), real) || ".";
  const path = `/proc/self/fd/${destination}/${name}`;
  try {
    unlinkAt(destination, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  symlinkSync(target, path);
}

const lexicallyInside = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

/**
 * The image owns the names it holds. When the entry the disk has under such a name is of another kind (the image turned
 * a link into a file or a folder, or a folder into a link), it is replaced instead of failing the seed: a file where a
 * folder goes is unlinked, a folder where a file or link goes is removed, and a link that resolves inside Pi's agent
 * folder (what an earlier seed made) is unlinked. A link that points elsewhere is left for the no-follow open to refuse.
 */
function clearForKind(destination: number, name: string, want: "dir" | "file", agentRoot: string): void {
  const path = `/proc/self/fd/${destination}/${name}`;
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (stat.isSymbolicLink()) {
    const base = readlinkSync(`/proc/self/fd/${destination}`);
    if (lexicallyInside(agentRoot, resolve(base, readlinkSync(path)))) unlinkAt(destination, name);
  } else if (stat.isDirectory() && want === "file") rmSync(path, { recursive: true, force: true });
  else if (stat.isFile() && want === "dir") unlinkAt(destination, name);
}

function copyTree(source: string, destination: number, imageRoot: string, agentRoot: string): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    if (entry.isDirectory()) {
      clearForKind(destination, entry.name, "dir", agentRoot);
      const child = openDirAt(destination, entry.name, { create: PRIVATE_FOLDER });
      try {
        copyTree(from, child, imageRoot, agentRoot);
      } finally {
        closeSync(child);
      }
    } else if (entry.isSymbolicLink()) {
      clearForKind(destination, entry.name, "file", agentRoot);
      copyLink(from, imageRoot, destination, entry.name);
    } else if (entry.isFile()) {
      clearForKind(destination, entry.name, "file", agentRoot);
      // The image is read-only and ours; the disk side is where a link could have been planted.
      const executable = (statSync(from).mode & 0o100) !== 0;
      writeFileAt(destination, entry.name, readFileSync(from), executable ? 0o700 : 0o600);
    }
  }
}

/**
 * SP5. The agent's OKF bundle: `index.md` and `log.md` in `knowledge/`, each made only when absent (O_EXCL, no-follow),
 * so a file the agent edited or deleted-and-kept, or a link planted there, is never touched or written through.
 */
function seedKnowledge(rootFd: number, layout: VmLayout, now: Date, skipped: (line: string) => void): void {
  let folderFd = -1;
  try {
    folderFd = openChain(rootFd, layout.root, layout.knowledge, PUBLIC_FOLDER);
    for (const [name, text] of [
      ["index.md", OKF_INDEX_TEXT],
      ["log.md", okfLogText(now)],
    ] as const) {
      try {
        writeFileAt(folderFd, name, Buffer.from(text), 0o644, WRITE_NEW | constants.O_NOFOLLOW);
      } catch (error) {
        // EEXIST: ours to leave. ELOOP: a link sits there; the exclusive create refuses it before following.
        if (!["EEXIST", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    }
  } catch (error) {
    // The bundle is a convenience: no failure here (ENOSPC, EACCES, EIO) may stop a VM start. Code only, once.
    skipped(
      `the knowledge bundle could not be seeded (${(error as NodeJS.ErrnoException).code ?? "unknown"})`,
    );
  } finally {
    if (folderFd >= 0) closeSync(folderFd);
  }
}

/**
 * R28 (RT-07) and AVM-P5. Makes the layout folders a blank disk lacks (`home`, `knowledge`, `inbox` 0755; Pi's `.pi`,
 * `sessions` and agent folder 0700), then copies every file of the image's agent folder over Pi's: image-owned files are
 * replaced, files only Pi made are kept. Every component is opened from its parent's descriptor with O_NOFOLLOW, so a link
 * or a file where a folder belongs is refused and nothing is written through it. Throws on the first refusal, except for the knowledge bundle's files, whose failure is told to `skipped` and skipped.
 */
export function seedAgentFolder(layout: VmLayout, skipped: (line: string) => void = () => {}): void {
  const rootFd = openRootDir(layout.root);
  try {
    for (const folder of [layout.home, layout.knowledge, layout.inbox]) {
      closeSync(openChain(rootFd, layout.root, folder, PUBLIC_FOLDER));
    }
    seedKnowledge(rootFd, layout, new Date(), skipped);
    for (const folder of [layout.pi, layout.sessions]) {
      closeSync(openChain(rootFd, layout.root, folder, PRIVATE_FOLDER));
    }
    const agentFd = openChain(rootFd, layout.root, layout.piAgentDir, PRIVATE_FOLDER);
    try {
      copyTree(layout.imageAgentDir, agentFd, realpathSync(layout.imageAgentDir), resolve(layout.piAgentDir));
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
