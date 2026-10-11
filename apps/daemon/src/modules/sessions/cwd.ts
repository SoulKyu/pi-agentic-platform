import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { PapError } from "@pap/contracts";

/** The real path of an existing folder; anything else (relative, `~`, missing, a file) is `invalid_cwd`. */
export function resolveSessionCwd(input: string): string {
  if (!input || !isAbsolute(input)) throw new PapError("invalid_cwd");
  try {
    const real = realpathSync(input);
    if (!statSync(real).isDirectory()) throw new PapError("invalid_cwd");
    return real;
  } catch (error) {
    throw error instanceof PapError ? error : new PapError("invalid_cwd");
  }
}
