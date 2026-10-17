import { chmodSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { UnsafeArchiveError } from "./member-path.ts";

const LINK = "the extracted tree holds a link or a special file";

/** A read error names a path the archive chose: it never reaches the message. */
function fixedError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof UnsafeArchiveError) throw error;
    throw new UnsafeArchiveError(
      `the extracted tree could not be read (${(error as { code?: string }).code ?? "error"})`,
    );
  }
}

/**
 * Layer 3: after `tar -x` and BEFORE any chmod or placement, every entry of the stage is lstat'ed. Anything that is not a
 * regular file or a folder (a symbolic link, a device, a FIFO), and any file with another hard link, refuses the restore.
 */
export function assertPlainTree(root: string, limit = 1_000_001): number {
  let count = 0;
  const visit = (path: string): void => {
    if (++count > limit) throw new UnsafeArchiveError("the extracted tree is larger than a backup can be");
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (!stat.isFile() || stat.nlink > 1) {
      throw new UnsafeArchiveError(LINK);
    }
  };
  fixedError(() => visit(root));
  return count;
}

/** Owner-only, whatever the archive said: keeps the owner bits (`mode & 0o700`, so scripts stay executable), never grants more. Run after `assertPlainTree`. */
export function ownerOnly(root: string): void {
  const visit = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      chmodSync(path, (stat.mode & 0o700) | 0o700);
      for (const name of readdirSync(path)) visit(join(path, name));
    } else if (stat.isFile() && stat.nlink === 1) {
      chmodSync(path, (stat.mode & 0o700) | 0o600);
    } else {
      throw new UnsafeArchiveError(LINK); // chmod would follow a link, or change a file the stage shares with another name
    }
  };
  fixedError(() => visit(root));
}
