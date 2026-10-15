import { statfsSync } from "node:fs";
import { dirname } from "node:path";
import { PapError } from "@pap/contracts";
import type { Logger } from "./logger.ts";

const MB = 1_048_576;

/** The two numbers of `fs.statfsSync` that matter here: free blocks available to a normal user, and their size. */
export type Statfs = (path: string) => { readonly bavail: number; readonly bsize: number };

/**
 * Free megabytes on the filesystem holding `path`, or null when it cannot be told. A folder that does not exist yet is
 * measured by its nearest existing parent (same filesystem unless something is mounted in between).
 */
export function freeMb(path: string, statfs: Statfs = statfsSync): number | null {
  let at = path;
  for (;;) {
    try {
      const { bavail, bsize } = statfs(at);
      return Math.floor((bavail * bsize) / MB);
    } catch (error) {
      const parent = dirname(at);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === at) return null;
      at = parent;
    }
  }
}

/** A floor of 0 is off and never asks the disk; an unknown figure passes: a guard, not a gate on the unknown. */
export function diskFloor(
  path: string,
  floorMb: number,
  statfs?: Statfs,
): { ok: true } | { ok: false; freeMb: number } {
  if (floorMb <= 0) return { ok: true };
  const free = freeMb(path, statfs);
  return free === null || free >= floorMb ? { ok: true } : { ok: false, freeMb: free };
}

/**
 * A check of a path chosen at each call, as the lanes seam wants it (`(path: string) => undefined`): throws `disk_low`
 * below the floor; a failing `statfs` lets the action through and is logged once. A floor of 0 is off (M10R100, M9R117).
 */
export function createPathDiskGuard(options: {
  readonly floorMb: number;
  readonly logger: Logger;
  readonly statfs?: Statfs;
}): (path: string) => undefined {
  let warned = false;
  return (path) => {
    if (options.floorMb <= 0) return undefined;
    const free = freeMb(path, options.statfs);
    if (free === null) {
      if (!warned) options.logger.warn("disk_free_unknown", { floorMb: options.floorMb });
      warned = true;
      return undefined;
    }
    if (free < options.floorMb) {
      options.logger.warn("disk_low", { freeMb: free, floorMb: options.floorMb });
      throw new PapError("disk_low");
    }
    return undefined;
  };
}

/** The same check for one fixed path (fork and clone quotas). */
export function createDiskGuard(options: {
  readonly path: string;
  readonly floorMb: number;
  readonly logger: Logger;
  readonly statfs?: Statfs;
}): () => void {
  const guard = createPathDiskGuard(options);
  return () => void guard(options.path);
}
