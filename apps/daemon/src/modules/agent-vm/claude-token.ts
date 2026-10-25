import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { ClaudeToken } from "@pap/contracts";

/** The most a token file holds: a `claude setup-token` value is a few hundred characters. */
const MAX_FILE_BYTES = 1024;
export const CLAUDE_TOKEN_FILE = "claude-token";
/** The folder of the Claude token under `$PAP_HOME`: the store and the secrets collector both name it through here (S1). */
export const secretsDirOf = (home: string): string => join(home, "secrets");
/** Only the class of a failure is logged (its code), never its message: a path or a value could be in it. */
export const errorClass = (error: unknown): string =>
  (error as NodeJS.ErrnoException | null)?.code ?? "error";

/**
 * The legacy token file (before M14 the one Claude token of the install, now moved into the owner's vault) read whole without following a link. `null` only when the file is absent; any other failure goes to `fail`
 * with a fixed word or an error code (never a message or the content), and `fail`'s answer is returned.
 */
export function readLegacyTokenFile(path: string, fail: (reason: string) => null): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    // A missing file is the normal "no token"; a link (ELOOP) or anything else is said, by class only.
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? null : fail(errorClass(error));
  }
  let token: string | null = null;
  let reason: string | null = null;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) reason = "not_a_token_file";
    else {
      const buffer = Buffer.alloc(stat.size);
      let read = 0;
      while (read < stat.size) {
        const count = readSync(fd, buffer, read, stat.size - read, read);
        if (count === 0) break;
        read += count;
      }
      const parsed = ClaudeToken.safeParse(buffer.subarray(0, read).toString("utf8"));
      if (parsed.success) token = parsed.data;
      else reason = "not_a_token";
    }
  } catch (error) {
    reason = errorClass(error);
  } finally {
    closeSync(fd);
  }
  return reason === null ? token : fail(reason);
}
