import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  readdirSync,
  readFileSync,
  openSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";

/** Same class as the archive builder (M6R8): the id goes into a path, so nothing else is accepted. */
export const RELEASE_ID = /^[A-Za-z0-9._-]{1,64}$/;

export const releaseDir = (app: string, id: string): string => join(app, "releases", checkedId(id));

export function checkedId(id: string): string {
  if (!RELEASE_ID.test(id) || id === "." || id === "..") throw new Error("invalid release id");
  return id;
}

/** The release `current` names, or null when there is none or the link is not the `releases/<id>` shape we write. */
export function readCurrent(app: string): string | null {
  try {
    const target = readlinkSync(join(app, "current"));
    const match = /^releases\/([A-Za-z0-9._-]{1,64})$/.exec(target);
    return match?.[1] !== undefined && match[1] !== "." && match[1] !== ".." ? match[1] : null;
  } catch {
    return null;
  }
}

/** A release the service can run: its Node binary and the daemon entry exist as regular files. */
export function releaseIsComplete(app: string, id: string): boolean {
  const dir = releaseDir(app, id);
  return [join(dir, "node", "bin", "node"), join(dir, "app", "apps", "daemon", "dist", "main.js")].every(
    (file) => {
      try {
        return statSync(file).isFile();
      } catch {
        return false;
      }
    },
  );
}

/**
 * Points `current` at `releases/<id>` in one step: a new relative symlink, then rename(2) over the old one (atomic on
 * POSIX, like `mv -T` in the installer). Refuses an incomplete release, so `current` never names something that cannot run.
 */
export function switchCurrent(app: string, id: string): void {
  if (!releaseIsComplete(app, id)) throw new Error(`release ${id} is incomplete`);
  const temp = join(app, `current.new.${process.pid}`);
  rmSync(temp, { force: true });
  symlinkSync(`releases/${id}`, temp);
  try {
    renameSync(temp, join(app, "current"));
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  const dir = openSync(app, "r");
  try {
    fsyncSync(dir); // the rename itself survives a power cut
  } finally {
    closeSync(dir);
  }
}

/** The complete releases other than `skip`, newest first by `BUILD_INFO.json` `builtAt` (an unreadable file sorts last). */
export function otherReleases(app: string, skip: string | null): string[] {
  const root = join(app, "releases");
  if (!existsSync(root)) return [];
  const built = (id: string): number => {
    try {
      const info = JSON.parse(readFileSync(join(releaseDir(app, id), "BUILD_INFO.json"), "utf8")) as {
        builtAt?: unknown;
      };
      return typeof info.builtAt === "string" ? Date.parse(info.builtAt) || 0 : 0;
    } catch {
      return 0;
    }
  };
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && RELEASE_ID.test(entry.name))
    .map((entry) => entry.name)
    .filter(
      (id) => id !== skip && releaseIsComplete(app, id) && !lstatSync(releaseDir(app, id)).isSymbolicLink(),
    )
    .sort((a, b) => built(b) - built(a) || (a < b ? 1 : -1));
}
