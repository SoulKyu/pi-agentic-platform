import { HELPER_OPS, PapError, type SubagentProfileFile } from "@pap/contracts";
import type { ProfilesDeps } from "./profiles.ts";

/** Reading one file: the helper starts, does it, answers. */
const DEADLINE_MS = 30_000;

/**
 * One profile whole (Task 29b, carry 1), for the child a `subagent` call makes. The same offline helper, the same trust check
 * on the session's folder (the folder goes to the helper only while Pi trusts it, and the helper checks again), the same
 * roots; the project's file wins over the user's. `not_found` for a name no file has, `conflict` for two files with one name.
 */
export function createProfileReader(deps: Pick<ProfilesDeps, "pi" | "sessions" | "logger">) {
  return {
    async get(ownerId: string, sessionId: string, name: string): Promise<SubagentProfileFile> {
      const cwd = deps.sessions.cwdOf(ownerId, sessionId);
      if (cwd === null) throw new PapError("not_found");
      const trusted = !deps.sessions.runsInVm(sessionId) && (await deps.pi.trust.status(cwd)) === true;
      const handle = deps.pi.helpers.run(
        "subagents.profile",
        { offline: true, name },
        { deadlineMs: DEADLINE_MS, ...(trusted ? { cwd } : {}) },
      );
      const parsed = HELPER_OPS["subagents.profile"].result.safeParse(await handle.done);
      if (!parsed.success) {
        deps.logger.warn("subagent_profile_invalid", { sessionId, issues: parsed.error.issues.length });
        throw new PapError("helper_failed");
      }
      return parsed.data;
    },
  };
}
