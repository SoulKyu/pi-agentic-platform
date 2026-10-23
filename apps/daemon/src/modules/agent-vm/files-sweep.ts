import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { TRASH_KEEP_MS } from "./trash.ts";

const DAY_MS = 86_400_000;

/**
 * At start and once a day, what is older than 7 days leaves `$PAP_HOME/secrets/agent-files/.trash`. The import route and a delete's move
 * to the trash do not depend on the VM runtime. (A VM's trash sweep does the same, harmlessly.)
 * Returns the way to stop.
 */
export function startFilesTrashSweep(deps: {
  files: { sweepTrash(now: number, keepMs: number): void };
  clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  logger: Pick<Logger, "warn">;
}): () => void {
  let timer: TimerHandle | null = null;
  const tick = (): void => {
    try {
      deps.files.sweepTrash(deps.clock.now(), TRASH_KEEP_MS);
    } catch (error) {
      deps.logger.warn("agent_files_trash_sweep_failed", { err: error });
    }
    timer = deps.clock.setTimeout(tick, DAY_MS);
  };
  tick();
  return () => {
    if (timer !== null) deps.clock.clearTimeout(timer);
    timer = null;
  };
}
