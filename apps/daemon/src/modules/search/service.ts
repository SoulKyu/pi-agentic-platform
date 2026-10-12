import { type Caller, SearchHit, SHELL_LIMITS } from "@pap/contracts";
import { cutUnits } from "../../kernel/text.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { matchExpression } from "./match.ts";
import type { SearchClient } from "./search-client.ts";

export function createSearchService(deps: {
  readonly client: Pick<SearchClient, "query">;
  readonly sessions: Pick<SessionsScanPort, "summary">;
}) {
  return {
    async query(
      caller: Caller,
      params: { q: string; limit?: number | undefined },
    ): Promise<{ hits: SearchHit[] }> {
      const match = matchExpression(params.q);
      if (match === null) return { hits: [] };
      const rows = await deps.client.query({
        match,
        ownerId: caller.userId,
        limit: params.limit ?? SHELL_LIMITS.searchHits,
      });
      const hits: SearchHit[] = [];
      for (const row of rows) {
        const session = deps.sessions.summary(row.sessionId, caller.userId);
        if (!session) continue;
        const hit = SearchHit.safeParse({
          sessionId: row.sessionId,
          entryId: row.entryId,
          role: row.role,
          at: row.at,
          snippet: cutUnits(row.snippet, SHELL_LIMITS.snippet),
          session,
        });
        // A row the contract cannot carry is dropped, never the whole answer (M4R134).
        if (hit.success) hits.push(hit.data);
      }
      // 20 hits of at most ~9 KB each: always far under the frame.
      return { hits };
    },
  };
}
export type SearchService = ReturnType<typeof createSearchService>;
