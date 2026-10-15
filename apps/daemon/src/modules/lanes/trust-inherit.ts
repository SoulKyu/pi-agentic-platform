import type { Caller } from "@pap/contracts";
import { isInHeadLineage } from "../../kernel/git/lineage.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { TrustPort } from "../trust/index.ts";

/** The folders whose content Pi loads and runs when a project is trusted (M7): a lane inherits only if they are unchanged. */
const TRUSTED_TREES = [".pi", ".agents/skills"] as const;

export interface InheritTrustDeps {
  readonly git: GitRunner;
  readonly logger: Logger;
  /** Pi's trust, once the daemon has bound it. */
  trust(): Pick<TrustPort, "status" | "inherit"> | undefined;
}

export interface InheritTrustLane {
  readonly ownerId: string;
  /** The project root as stored: Pi's decision is about this folder. */
  readonly projectRoot: string;
  readonly worktree: string;
  readonly baseOid: string;
  /** Who created the lane: a token's lane inherits only from the main checkout's own commit. */
  readonly by: Pick<Caller, "kind" | "credentialId">;
  /** The real path of the main checkout: where git reads the trees. */
  readonly root: string;
}

/**
 * Trust inheritance (M9R83, owner m9q2). A new worktree gets the project's decision only when Pi's store trusts the
 * project root and the code Pi would load from the lane, `.pi` and `.agents/skills`, is the very tree the main checkout
 * has. Equal trees are not enough when the rest of the tree differs (relative package paths, imports outside `.pi`), so
 * a lane inherits only when its base is the main checkout's HEAD or an ancestor of it, and a token's lane only from
 * HEAD itself. Otherwise nothing is written and the trust banner asks the owner. Never throws; true when it wrote.
 */
export function createInheritTrust(deps: InheritTrustDeps): (lane: InheritTrustLane) => Promise<boolean> {
  /** The tree id of `path` at `rev`, or "" when it does not exist there. */
  async function treeAt(root: string, rev: string, path: string): Promise<string> {
    const { stdout } = await deps.git.run(root, ["rev-parse", "--verify", "--quiet", `${rev}:${path}`], {
      okCodes: [0, 1],
    });
    return stdout.toString("utf8").trim();
  }

  /** The commit id of `rev`, or "" when it does not resolve. */
  async function commitAt(root: string, rev: string): Promise<string> {
    const { stdout } = await deps.git.run(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], {
      okCodes: [0, 1],
    });
    return stdout.toString("utf8").trim();
  }

  return async (lane) => {
    const trust = deps.trust();
    if (trust === undefined) return false;
    try {
      // Lineage, not ref names: only a base the main checkout's HEAD already contains is the owner's own work.
      if (!(await isInHeadLineage(deps.git, lane.root, lane.baseOid))) return false;
      if (lane.by.kind === "token" && lane.baseOid !== (await commitAt(lane.root, "HEAD"))) return false;
      // Cheap git comparison first: `status` takes a Pi helper slot (PAP_HELPERS_MAX), scarce in a fan-out (T18a-m10).
      for (const path of TRUSTED_TREES) {
        const [there, here] = await Promise.all([
          treeAt(lane.root, lane.baseOid, path),
          treeAt(lane.root, "HEAD", path),
        ]);
        if (there !== here) return false;
      }
      // `status` answers null when there is no decision or the helper failed: both count as untrusted.
      if ((await trust.status(lane.projectRoot)) !== true) return false;
      return await trust.inherit(lane.ownerId, lane.worktree, lane.projectRoot, lane.by);
    } catch (error) {
      deps.logger.warn("lane_trust_inherit_failed", { err: error });
      return false;
    }
  };
}
