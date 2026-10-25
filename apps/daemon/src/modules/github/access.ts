import { PapError, type RepoFullName } from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import { type GithubClient, GithubUnauthorized } from "./client.ts";
import type { UserTokens } from "./user-tokens.ts";

/** A decision is trusted for ten minutes; a box renewal (45 minutes) or a start therefore re-asks GitHub. */
export const ACCESS_TTL_MS = 10 * 60_000;
/** What a rate limit or an outage may keep standing: one box token's lifetime, from the last successful check. */
export const STALE_MAX_MS = 60 * 60_000;
const MAX_ENTRIES = 512;

const Repo = z.object({ permissions: z.object({ push: z.boolean() }).partial().optional() });

export interface GithubAccess {
  /**
   * Resolves when `ownerId`'s own GitHub token reaches `repository` with push; `not_found` otherwise, whether the repository
   * exists or not. The App reaching the repository is never enough: its JWT reaches every installation.
   * `capacity` and `github_unavailable` are not a verdict: they throw, unless an earlier decision can stand in (not for a `fresh` call).
   * `fresh` ignores a cached decision (an interactive call); the answer still refreshes the cache.
   */
  check(ownerId: string, repository: RepoFullName, options?: { fresh?: boolean }): Promise<void>;
}

export function createAccess(deps: {
  readonly client: GithubClient;
  readonly userTokens: UserTokens;
  readonly clock: Clock;
}): GithubAccess {
  const { client, userTokens, clock } = deps;
  const decisions = new Map<string, { allowed: boolean; at: number }>();

  async function ask(ownerId: string, repository: RepoFullName): Promise<boolean> {
    // No usable user token is a lost access, not an outage: the member disconnected or must reconnect.
    if (userTokens.state(ownerId) !== "ok") return false;
    try {
      const value = await userTokens.get(ownerId);
      const answer = await client.json(Repo, {
        path: `/repos/${repository}`,
        auth: { kind: "bearer", value },
      });
      return answer.permissions?.push === true;
    } catch (error) {
      // A refused credential (revoked authorization, expired token) is a lost access, never an outage.
      if (error instanceof GithubUnauthorized) return false;
      if (error instanceof PapError && (error.code === "not_found" || error.code === "forbidden"))
        return false;
      throw error;
    }
  }

  return {
    async check(ownerId, repository, options = {}) {
      const key = `${ownerId}\n${repository}`;
      const known = decisions.get(key);
      const live = known !== undefined && clock.now() - known.at < ACCESS_TTL_MS;
      let allowed: boolean;
      if (live && known && options.fresh !== true) allowed = known.allowed;
      else {
        try {
          allowed = await ask(ownerId, repository);
          if (decisions.size >= MAX_ENTRIES) {
            for (const [name, one] of decisions)
              if (clock.now() - one.at >= STALE_MAX_MS) decisions.delete(name);
            const oldest = decisions.keys().next().value;
            if (decisions.size >= MAX_ENTRIES && oldest !== undefined) decisions.delete(oldest);
          }
          decisions.set(key, { allowed, at: clock.now() });
        } catch (error) {
          // A rate limit or an outage is not a revocation: the last decision stands for at most an hour, and the next call asks again.
          if (options.fresh === true || known === undefined || clock.now() - known.at >= STALE_MAX_MS)
            throw error;
          allowed = known.allowed;
        }
      }
      if (!allowed) throw new PapError("not_found");
    },
  };
}
