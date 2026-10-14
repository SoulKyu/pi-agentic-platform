import { PapError } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import { shellEnv } from "../../kernel/pty/env.ts";
import type { NodePty } from "../../kernel/pty/load.ts";
import { ptySpec, shellOf, spawnPty } from "../../kernel/pty/spawn.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import type { TerminalRegistryDeps } from "./registry.ts";

export interface LaunchDeps {
  readonly env: NodeJS.ProcessEnv;
  readonly scopes: Pick<WorkerScopes, "next">;
  /** The umask the daemon started with (R114), the value `prepareHome` returned: the shell runs under it (MC26 I3). */
  readonly workerUmask: number;
  readonly logger: Logger;
  /** Null when the native module did not load (M8R51). */
  loadPty(): NodePty | null;
}

/** Starts a shell in its own scope with a clean environment (M8R53, M8R54). Nothing but a code reaches the client. */
export function createLauncher(deps: LaunchDeps): TerminalRegistryDeps["launch"] {
  return ({ cwd, cols, rows }) => {
    const pty = deps.loadPty();
    if (!pty) throw new PapError("terminal_unavailable");
    const scope = deps.scopes.next({ kind: "terminal" });
    try {
      const spec = ptySpec({
        shell: shellOf(deps.env),
        cwd,
        cols,
        rows,
        env: shellEnv(deps.env),
        scope: scope?.launch ?? null,
        umask: deps.workerUmask,
      });
      return { pty: spawnPty(pty, spec, deps.logger), scope };
    } catch (error) {
      deps.logger.warn("terminal_spawn_failed", { code: (error as NodeJS.ErrnoException).code ?? "unknown" });
      // A scope that never got its shell must not stay behind.
      void scope?.reap({ signal: null });
      throw new PapError("terminal_unavailable");
    }
  };
}
