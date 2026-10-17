import { realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { PapError } from "@pap/contracts";

/** `<real $PAP_HOME>/agents`, or null when `$PAP_HOME` does not exist (nothing can be inside it then). */
function agentsFolder(papHome: string): string | null {
  try {
    return join(realpathSync(papHome), "agents");
  } catch {
    return null;
  }
}

/**
 * The real path of an existing folder; anything else (relative, `~`, missing, a file) is `invalid_cwd`. With `papHome`, a
 * folder inside `$PAP_HOME/agents` is `invalid_cwd` too, in every spelling: only the agent port stores a row there
 * (M11R179, RT-12), so no plain session edits an agent's files with Pi's own tools.
 */
export function resolveSessionCwd(input: string, papHome?: string): string {
  if (!input || !isAbsolute(input)) throw new PapError("invalid_cwd");
  try {
    const real = realpathSync(input);
    if (!statSync(real).isDirectory()) throw new PapError("invalid_cwd");
    const agents = papHome === undefined ? null : agentsFolder(papHome);
    if (agents !== null && (real === agents || real.startsWith(`${agents}/`)))
      throw new PapError("invalid_cwd");
    return real;
  } catch (error) {
    throw error instanceof PapError ? error : new PapError("invalid_cwd");
  }
}
