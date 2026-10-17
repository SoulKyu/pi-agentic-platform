// The known-device.ts pattern (O_EXCL, O_NOFOLLOW, fchmod), copied: a module may not import auth's internals.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  linkSync,
  openSync,
  rmSync,
  writeFileSync,
} from "node:fs";

/** true: this call created the file; false: it already existed (EEXIST) and was left untouched. */
export function writeExclusive(path: string, content: string): boolean {
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`; // random: a stale file of a crashed process (same PID in a container) can never collide
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(fd, 0o600); // a umask only narrows the mode, so this is exact
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path); // fails with EEXIST when another writer (or a link) is already there: nothing is overwritten
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(tmp, { force: true }); // a missing temporary must never mask a success
  }
}
