import { closeSync, constants, fstatSync, openSync, readSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ClaudeToken, PapError } from "@pap/contracts";
import { ensurePrivateFolder, PrivateFolderError, writePrivateFile } from "../../kernel/fs/private-write.ts";
import type { Logger } from "../../kernel/logger.ts";

/** The most a token file holds: a `claude setup-token` value is a few hundred characters. */
const MAX_FILE_BYTES = 1024;
export const CLAUDE_TOKEN_FILE = "claude-token";
/** The folder of the Claude token under `$PAP_HOME`: the store and the secrets collector both name it through here (S1). */
export const secretsDirOf = (home: string): string => join(home, "secrets");
/** Only the class of a failure is logged (its code), never its message: a path or a value could be in it. */
const errorClass = (error: unknown): string => (error as NodeJS.ErrnoException | null)?.code ?? "error";

/**
 * The token file read whole without following a link. `null` only when the file is absent; any other failure goes to `fail`
 * with a fixed word or an error code (never a message or the content), and `fail`'s answer is returned.
 */
function readTokenFile(path: string, fail: (reason: string) => null): string | null {
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

/**
 * For the image scan (T15b): the stored token, or `null` only when no token file exists. A link, an unreadable or odd file,
 * an oversized or invalid one throws a fixed-word error, so a build never goes ahead without a value it should have scanned for.
 */
export function loadClaudeTokenStrict(secretsDir: string): string | null {
  return readTokenFile(join(secretsDir, CLAUDE_TOKEN_FILE), (reason) => {
    throw new Error(`claude token unreadable (${reason})`);
  });
}

export interface ClaudeTokenStore {
  /** `set` or `missing`, never the value (RT-46). */
  status(): "set" | "missing";
  /** Writes the token whole to a temporary name and renames it over `claude-token` (0600 in a 0700 folder). */
  set(token: string): void;
  /** Removes the file; a missing token is fine. */
  clear(): void;
  /** The stored token, or null: the relay link replays it after a restart. A link or an odd file reads as none. */
  load(): string | null;
  /** Called with the new token (or null) after a `set` or a `clear`: the relay link pushes it. */
  onChange(listener: (token: string | null) => void): void;
}

/**
 * The owner's `claude setup-token` value (R13, RT-46) in `$PAP_HOME/secrets/claude-token`, the only place pap stores it. It is
 * opened without following a link, written whole then renamed (a rename replaces a link instead of writing through it), and
 * never reaches a log line, a status or an error: only fixed words and error classes do.
 */
export function createClaudeTokenStore(deps: {
  readonly secretsDir: string;
  readonly logger: Logger;
}): ClaudeTokenStore {
  const { secretsDir, logger } = deps;
  const path = join(secretsDir, CLAUDE_TOKEN_FILE);
  const listeners = new Set<(token: string | null) => void>();
  const tell = (token: string | null): void => {
    for (const listener of listeners) {
      try {
        listener(token);
      } catch (error) {
        logger.warn("claude_token_listener_failed", { err: errorClass(error) });
      }
    }
  };

  /** The folder exists, is a real folder (not a link) and is 0700. */
  function ensureFolder(): void {
    try {
      ensurePrivateFolder(secretsDir);
    } catch (error) {
      // A link or a file where the folder should be: said by class, then refused.
      if (error instanceof PrivateFolderError)
        logger.error("claude_token_folder_refused", { err: error.reason });
      throw error instanceof PrivateFolderError ? new PapError("internal") : error;
    }
  }

  const load = (): string | null =>
    readTokenFile(path, (reason) => {
      logger.warn("claude_token_unreadable", { err: reason });
      return null;
    });

  return {
    status: () => (load() === null ? "missing" : "set"),
    load,
    set(token) {
      ensureFolder();
      try {
        writePrivateFile(path, Buffer.from(token, "utf8"));
      } catch (error) {
        logger.error("claude_token_write_failed", { err: errorClass(error) });
        throw new PapError("internal");
      }
      logger.info("claude_token_set");
      tell(token);
    },
    clear() {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          logger.error("claude_token_clear_failed", { err: errorClass(error) });
          throw new PapError("internal");
        }
      }
      logger.info("claude_token_cleared");
      tell(null);
    },
    onChange(listener) {
      listeners.add(listener);
    },
  };
}
