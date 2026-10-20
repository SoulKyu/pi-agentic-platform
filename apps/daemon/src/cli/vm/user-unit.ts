import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { UNIT } from "../service/common.ts";

/** A unit file pap writes is a few hundred bytes. */
export const MAX_UNIT_BYTES = 64 * 1024;

/**
 * N5: root reads the unit of pap's user, so it never follows a link, never waits on a FIFO (`O_NONBLOCK`), reads only a regular
 * file and at most `MAX_UNIT_BYTES`. Anything else, or any error, is "no unit" (setup then uses the default home).
 */
export function readUserUnitText(userHome: string): string | null {
  let fd: number;
  try {
    fd = openSync(
      join(userHome, ".config/systemd/user", UNIT),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_UNIT_BYTES) return null;
    const bytes = Buffer.alloc(stat.size);
    let at = 0;
    while (at < bytes.length) {
      const read = readSync(fd, bytes, at, bytes.length - at, at);
      if (read === 0) break;
      at += read;
    }
    return bytes.toString("utf8", 0, at);
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}
