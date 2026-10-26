import { type AgentFilesSource, agentOfPath } from "../agent-path.ts";
import type { ProjectBoxSource } from "../boxes.ts";
import { assertBoxOnly, type IsMember } from "../box-path.ts";

/**
 * The deny-by-default walk over the client paths of a request (M14, RT-07): a member's request carries box paths only.
 * `paths` are the `ClientPath` values the params parse recorded, so a new path field is gated by using the schema.
 * Lexical only: no stat and no realpath of the host happens before the answer.
 */
export interface ClientPathGate {
  /** `surface: "files"` (the `files.*` methods and the files HTTP routes) also lets a member name their own agent's folder. */
  allows(userId: string, paths: readonly string[], surface?: "files"): boolean;
}

export function createClientPathGate(deps: {
  readonly isMember: IsMember;
  readonly boxes: () => ProjectBoxSource | undefined;
  /** A member's own agent's folder (`/agents/<id>`) is allowed too; with none bound, no agent path is. */
  readonly agents?: () => AgentFilesSource | undefined;
}): ClientPathGate {
  return {
    allows(userId, paths, surface) {
      if (paths.length === 0 || !deps.isMember(userId)) return true;
      const source = deps.boxes();
      try {
        for (const path of paths) {
          const agent = agentOfPath(path);
          if (
            surface === "files" &&
            agent !== null &&
            deps.agents?.()?.guestRootOf(userId, agent.agentId) != null
          )
            continue;
          assertBoxOnly(deps, source, userId, path);
        }
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** For a route or a test that carries no host path: nothing to walk. */
export const NO_CLIENT_PATHS: ClientPathGate = { allows: () => true };
