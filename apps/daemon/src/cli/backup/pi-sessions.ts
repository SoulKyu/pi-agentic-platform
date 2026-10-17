import { constants, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";

export type Counts = { added: number; skipped: number; note: string | null };

const codeOf = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "error";

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (codeOf(error) === "ENOENT") return false;
    throw error;
  }
};

/**
 * Copies `source` below `<realpath(piDir)>/sessions` file by file: never over an existing file, never through a link.
 * Nothing here stops the restore: a Pi folder that cannot be prepared turns every file into a skipped one, with the reason.
 */
export function addPiSessions(source: string, piDir: string): Counts {
  const counts: Counts = { added: 0, skipped: 0, note: null };
  try {
    if (!lstatSync(source).isDirectory()) return counts;
  } catch {
    return counts; // the manifest lists pi-agent but the archive holds no sessions
  }
  let sessions = "";
  try {
    mkdirSync(piDir, { recursive: true, mode: 0o700 });
    sessions = join(realpathSync(piDir), "sessions");
    if (!exists(sessions)) mkdirSync(sessions, { mode: 0o700 });
    const stat = lstatSync(sessions);
    if (!stat.isDirectory())
      counts.note = stat.isSymbolicLink()
        ? "the sessions folder of Pi is a symbolic link"
        : "the sessions path of Pi is not a folder";
  } catch (error) {
    counts.note = `the Pi folder could not be prepared (${codeOf(error)})`;
  }
  const place = (file: string): void => {
    const parts = relative(source, file).split("/");
    let at = sessions;
    for (const part of parts.slice(0, -1)) {
      at = join(at, part);
      if (!exists(at)) mkdirSync(at, { mode: 0o700 });
      if (!lstatSync(at).isDirectory()) throw new Error("parent is not a folder");
    }
    copyFileSync(file, join(at, parts[parts.length - 1] ?? ""), constants.COPYFILE_EXCL);
  };
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      if (lstatSync(child).isDirectory()) visit(child);
      else {
        try {
          if (counts.note !== null) throw new Error("no usable sessions folder");
          place(child);
          counts.added++;
        } catch {
          counts.skipped++; // exists, or a parent that is not a folder
        }
      }
    }
  };
  visit(source);
  return counts;
}
