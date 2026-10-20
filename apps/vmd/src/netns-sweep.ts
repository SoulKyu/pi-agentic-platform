import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import type { Logger } from "./log.ts";

/** nerdctl 2.4.1 leaves one `cnitest-<uuid>` file in /run/netns per `run` (115 seen on the real stack, T20a). */
export const NETNS_DIR = "/run/netns";
const CNI_TEST = /^cnitest-[0-9a-f-]{36}$/;

export interface NetnsSweepDeps {
  readonly dir: string;
  readonly log: Logger;
  list(dir: string): string[];
  /** `/proc/self/mountinfo` as pap-vmd sees it. */
  mountinfo(): string;
  unlink(file: string): void;
}

/** The mount points of a mountinfo text (field 5, with its octal escapes decoded). */
export function mountPointsOf(mountinfo: string): Set<string> {
  const points = new Set<string>();
  for (const line of mountinfo.split("\n")) {
    const point = line.split(" ")[4];
    if (point !== undefined)
      points.add(
        point.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))),
      );
  }
  return points;
}

/**
 * Unlinks the `cnitest-*` files that are not mount points (AVM-E62): a mounted one is a namespace in use and stays. The caller
 * holds the start lock, so no `nerdctl run` is creating one right now. Returns how many files it removed.
 */
export function sweepCniNetns(deps: NetnsSweepDeps): number {
  const mounted = mountPointsOf(deps.mountinfo());
  let removed = 0;
  for (const name of deps.list(deps.dir)) {
    const file = path.join(deps.dir, name);
    if (!CNI_TEST.test(name) || mounted.has(file)) continue;
    try {
      deps.unlink(file);
      removed++;
    } catch {
      // gone already, or busy: the next sweep tries again
    }
  }
  if (removed > 0) deps.log.info("vmd_netns_swept", { removed });
  return removed;
}

export function realNetnsSweep(log: Logger, dir = NETNS_DIR): () => number {
  return () =>
    sweepCniNetns({
      dir,
      log,
      list: (folder) => {
        try {
          return readdirSync(folder);
        } catch {
          return [];
        }
      },
      mountinfo: () => readFileSync("/proc/self/mountinfo", "utf8"),
      unlink: unlinkSync,
    });
}
