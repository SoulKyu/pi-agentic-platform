import { lstatSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { ensureFolder, existsNoFollow, FOLDER_MODE } from "./mirror-files.ts";

/** R14: a replaced mirror is kept this long. */
export const KEEP_MS = 7 * 24 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;
const KEPT_FOLDER = "replaced";
const STAMPED = /^(.+)\.(\d{10,16})$/;

/**
 * Moves the mirror at `path` to `replaced/<name>.<stamp>` beside it (0700 folder, the file keeps its 0600) and returns the
 * new path. Never overwrites an earlier copy: a stamp already taken is moved on by one.
 */
export function keepCopy(path: string, clock: Clock): string {
  const folder = join(dirname(path), KEPT_FOLDER);
  mkdirSync(folder, { recursive: true, mode: FOLDER_MODE });
  ensureFolder(folder);
  let stamp = clock.now();
  let target = join(folder, `${basename(path)}.${stamp}`);
  while (existsNoFollow(target)) target = join(folder, `${basename(path)}.${++stamp}`);
  renameSync(path, target);
  return target;
}

/**
 * Deletes the kept copies older than 7 days under every agent's mirror folder; the age is the stamp in the name. A link is
 * unlinked, never followed; a name with no stamp is left alone. Returns what was removed and which agents lost a copy.
 */
export function sweepKept(
  papHome: string,
  clock: Clock,
  logger: Logger,
): { removed: number; agents: string[] } {
  const root = join(papHome, "agents", ".mirrors");
  const agents = new Set<string>();
  let removed = 0;
  let folders: string[];
  try {
    folders = readdirSync(root);
  } catch {
    return { removed: 0, agents: [] };
  }
  for (const agent of folders) {
    const kept = join(root, agent, KEPT_FOLDER);
    let names: string[];
    try {
      names = readdirSync(kept);
    } catch {
      continue;
    }
    for (const name of names) {
      const stamp = STAMPED.exec(name)?.[2];
      if (stamp === undefined || clock.now() - Number(stamp) < KEEP_MS) continue;
      try {
        lstatSync(join(kept, name));
        unlinkSync(join(kept, name));
        removed++;
        agents.add(agent);
      } catch (error) {
        logger.warn("agent_mirror_keep_not_removed", { agentId: agent, err: error });
      }
    }
  }
  return { removed, agents: [...agents].sort() };
}

export interface KeepSweeper {
  start(): void;
  stop(): void;
}

/** Sweeps at start and every hour (the stamp decides, so a coarse tick is enough). */
export function createKeepSweeper(deps: {
  readonly papHome: string;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The agents whose kept copies were removed: their quota is counted again. */
  onSwept(agents: readonly string[]): void;
}): KeepSweeper {
  let timer: TimerHandle | undefined;
  let running = false;
  const tick = (): void => {
    const { removed, agents } = sweepKept(deps.papHome, deps.clock, deps.logger);
    if (removed > 0) deps.onSwept(agents);
    if (running) timer = deps.clock.setTimeout(tick, SWEEP_EVERY_MS);
  };
  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      if (timer) deps.clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
