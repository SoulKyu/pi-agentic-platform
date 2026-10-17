import { type Caller, HELPER_OPS, PapError, type SubagentsProfilesResult } from "@pap/contracts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";

/** Reading a few small files: the helper starts, does it, answers. */
const DEADLINE_MS = 30_000;

/** What the module needs of the Pi modules, bound at composition (the helper pool and the trust port). */
export interface SubagentsPi {
  readonly helpers: HelperPool;
  readonly trust: { status(folder: string): Promise<boolean | null> };
}

export interface ProfilesDeps {
  readonly pi: SubagentsPi;
  readonly sessions: {
    /** The folder of the owner's session; null when there is no such session of theirs. */
    cwdOf(ownerId: string, sessionId: string): string | null;
    /** True for a session of an agent (and its children): its home is not a project (W5-R27, W5-R29). */
    isAgentSession(sessionId: string): boolean;
  };
  readonly logger: Logger;
}

/**
 * The profiles a session can pick for a subagent (M11R135): Pi's agent files, read offline by the helper. The session's
 * folder goes to the helper only when Pi trusts it, so an untrusted repository never defines a child's prompt; the helper
 * checks the trust store again before it opens `.pi/agents`. Never for an agent's session: its home is agent-written and
 * not a project (W5-R27, W5-R29), whatever Pi's trust store says of an ancestor.
 */
export function createProfiles(deps: ProfilesDeps) {
  return {
    async list(caller: Caller, sessionId: string): Promise<SubagentsProfilesResult> {
      const cwd = deps.sessions.cwdOf(caller.userId, sessionId);
      if (cwd === null) throw new PapError("not_found");
      const trusted = !deps.sessions.isAgentSession(sessionId) && (await deps.pi.trust.status(cwd)) === true;
      const handle = deps.pi.helpers.run(
        "subagents.profiles",
        { offline: true },
        { deadlineMs: DEADLINE_MS, ...(trusted ? { cwd } : {}) },
      );
      const parsed = HELPER_OPS["subagents.profiles"].result.safeParse(await handle.done);
      if (!parsed.success) {
        deps.logger.warn("subagents_helper_result_invalid", { issues: parsed.error.issues.length });
        throw new PapError("helper_failed");
      }
      const { parse, refused, tooLarge } = parsed.data.skipped;
      if (parse + refused + tooLarge > 0)
        deps.logger.warn("subagent_profiles_skipped", { sessionId, parse, refused, tooLarge });
      return parsed.data;
    },
  };
}
export type Profiles = ReturnType<typeof createProfiles>;
