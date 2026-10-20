import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock } from "../../kernel/clock.ts";
import { diskFloor, type Statfs } from "../../kernel/disk.ts";

/** R32: said to the thread when an agent's conversations fill the disk it was given, or the host is short of space. */
export const QUOTA_NOTICE = "Les conversations de cet agent ont atteint la taille de son disque.";
const FLOOR_CHECK_MS = 5_000;

export interface Quota {
  /** Whether `bytes` more may be written for the agent: under `limitBytes` with its kept copies counted, and the host above its floor. */
  allow(agentId: string, bytes: number, limitBytes: number): boolean;
  /** Bytes written for the agent. */
  added(agentId: string, bytes: number): void;
  /** A file of the agent's was removed: its use is counted again at the next `allow`. */
  forget(agentId: string): void;
}

/** The size of the regular files of a folder and of its `replaced/` folder; links are not followed. */
function usedIn(folder: string): number {
  let total = 0;
  for (const dir of [folder, join(folder, "replaced")]) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        const found = lstatSync(join(dir, name));
        if (found.isFile()) total += found.size;
      } catch {
        // A file that went away while counting is not counted.
      }
    }
  }
  return total;
}

/**
 * RT-27, R32: an agent's mirrors (kept copies included) stay under its `diskMb`, and no append is taken while `$PAP_HOME`'s free
 * space is under the floor (`PAP_MIN_FREE_DISK_MB`, 0 = off). `statfs` is asked at most every 5 s.
 */
export function createQuota(deps: {
  readonly papHome: string;
  readonly clock: Clock;
  readonly minFreeMb: number;
  readonly statfs?: Statfs;
}): Quota {
  const used = new Map<string, number>();
  let floor: { at: number; ok: boolean } | null = null;
  const floorOk = (): boolean => {
    const now = deps.clock.now();
    if (floor === null || now - floor.at >= FLOOR_CHECK_MS) {
      floor = { at: now, ok: diskFloor(deps.papHome, deps.minFreeMb, deps.statfs).ok };
    }
    return floor.ok;
  };
  const usedOf = (agentId: string): number => {
    let known = used.get(agentId);
    if (known === undefined) {
      known = usedIn(join(deps.papHome, "agents", ".mirrors", agentId));
      used.set(agentId, known);
    }
    return known;
  };
  return {
    allow: (agentId, bytes, limitBytes) => floorOk() && usedOf(agentId) + bytes <= limitBytes,
    added(agentId, bytes) {
      used.set(agentId, usedOf(agentId) + bytes);
    },
    forget: (agentId) => void used.delete(agentId),
  };
}
