import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { type Intent, judgePath, type Scope } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import { BoundaryError, type OpenGuard } from "../../kernel/fs/safe-open.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PathLock } from "./path-lock.ts";

/** What every read of the files module leans on. */
export interface FilesEnv {
  readonly git: GitRunner;
  readonly deny: DenySet;
  readonly clock: Clock;
  readonly logger: Logger;
}

/** What a write leans on: the above and the chain per real path around a check and its write (MC38 m1). */
export interface WriteEnv extends FilesEnv {
  readonly locks: PathLock;
}

/** Errors of the fs layer that only say "nothing for you here": no existence oracle (C 4.1, carry 7). */
const NOT_THERE: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EACCES",
  "EPERM",
  "EISDIR",
  "ENXIO",
  "ENAMETOOLONG",
  "ENODEV",
]);

/**
 * The error a client sees for what the fs layer threw. Every boundary refusal and every errno that means "not there or not
 * yours" is `not_found` with its fixed message (the path and the errno go nowhere); a `PapError` stays; anything else
 * (EMFILE, EIO, a bug) is returned as it is for the dispatcher to log and answer `internal`.
 */
export function refusal(error: unknown, logger: Logger): unknown {
  if (error instanceof PapError) return error;
  if (error instanceof BoundaryError) {
    logger.debug("files_refused", { reason: error.reason });
    return new PapError("not_found");
  }
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NOT_THERE.has(code)) {
    logger.debug("files_refused", { errno: code });
    return new PapError("not_found");
  }
  return error;
}

export interface Judged {
  /** Where the path really leads. */
  readonly real: string;
  readonly protection: "none" | "confirm" | "step_up";
  /** False for a path a write may create. */
  readonly exists: boolean;
  readonly guard: OpenGuard;
}

/** The boundary's verdict on a path, or `not_found` whatever the reason (a refusal never says why). */
export async function judged(env: FilesEnv, scope: Scope, path: string, intent: Intent): Promise<Judged> {
  const judgement = await judgePath(path, scope, intent);
  if (!judgement.ok) {
    env.logger.debug("files_refused", { why: judgement.why });
    throw new PapError("not_found");
  }
  return {
    real: judgement.real,
    protection: judgement.protection,
    exists: judgement.exists,
    guard: { ...scope, root: judgement.root, deny: env.deny },
  };
}
