import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "../../kernel/logger.ts";

export type SkewVerdict = "ok" | "stale" | "unchecked";

export interface BundleSkew {
  /** Whether the bundle installed for the VMs is the one built with this daemon. `stale` is logged once per agent. */
  check(agentId: string): Promise<SkewVerdict>;
}

export interface BundleSkewDeps {
  /** The bundle built with this daemon (`packages/pi-host/dist-agent`), or null for an install without it. */
  readonly treeBundle: string | null;
  /** The digest of the installed bundle; `fresh` reads it again (a `pap vm setup` since the last read). */
  installedDigest(fresh?: boolean): Promise<string>;
  treeDigest(dir: string): Promise<string>;
  readonly logger: Logger;
}

/** `packages/pi-host/dist-agent` of the tree (or archive) the daemon runs from, found above `from`, or null. */
export function treeBundleOf(from: string): string | null {
  for (let dir = from; dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "packages/pi-host/dist-agent");
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * The code in a VM is the installed agent bundle. The daemon takes the digest of the bundle built with it once, at the first
 * check: that is the code it runs with, and a rebuild while pap runs does not flip the verdict.
 */
export function createBundleSkew(deps: BundleSkewDeps): BundleSkew {
  const { treeBundle, logger } = deps;
  let own: Promise<string> | undefined;
  let unchecked = false;
  const told = new Set<string>();

  return {
    async check(agentId) {
      if (treeBundle === null) {
        if (!unchecked) logger.info("vm_bundle_unchecked");
        unchecked = true;
        return "unchecked";
      }
      own ??= deps.treeDigest(treeBundle);
      let wanted: string;
      try {
        wanted = await own;
      } catch (error) {
        // A tree being rebuilt under us (`pnpm build`): do not cache the failure, and do not fail the launch.
        own = undefined;
        logger.info("vm_bundle_unchecked", { err: error });
        return "unchecked";
      }
      // A stale verdict is confirmed with a fresh read: `pap vm setup` may have run since the installed digest was cached.
      if ((await deps.installedDigest()) === wanted) return "ok";
      if ((await deps.installedDigest(true)) === wanted) return "ok";
      if (!told.has(agentId)) {
        told.add(agentId);
        logger.warn("vm_bundle_stale", { agentId });
      }
      return "stale";
    },
  };
}
