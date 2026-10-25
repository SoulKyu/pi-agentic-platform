import { HELPER_OPS, type HandlerTable, PapError } from "@pap/contracts";
import type { HelperPool } from "../../kernel/helper/pool.ts";
import type { Logger } from "../../kernel/logger.ts";

const DEADLINE_MS = 30_000;
/** The result schema's `source` limit; the helper allows 2048, so one long source is cut here and never breaks the response. */
const SOURCE_MAX = 1024;

export type AgentsPackagesRpc = Pick<HandlerTable, "agents.packages">;

export interface AgentPackages {
  /** The user-scope Pi packages, as the agent form picks them: the id an agent saves and its masked source. */
  list(): Promise<{ packages: Array<{ id: string; source: string }> }>;
}

/**
 * M14: the agent form's package list for any user. `plugins.list` is `pi:read` (a member has none), and it is shared anyway:
 * every user's agents draw on the one Pi folder. The helper runs with no folder, so only the user scope is read, and it
 * masks each source (a source may hold a credential); an id is all a browser ever saves, the daemon resolves it (AVM-E33).
 */
export function createAgentPackages(deps: {
  readonly helpers: Pick<HelperPool, "run">;
  readonly logger: Pick<Logger, "warn">;
}): AgentPackages {
  return {
    async list() {
      const handle = deps.helpers.run("plugins.list", {}, { deadlineMs: DEADLINE_MS });
      const parsed = HELPER_OPS["plugins.list"].result.safeParse(await handle.done);
      if (!parsed.success) {
        deps.logger.warn("agent_packages_result_invalid", { issues: parsed.error.issues.length });
        throw new PapError("helper_failed");
      }
      const byId = new Map<string, { id: string; source: string }>();
      for (const plugin of parsed.data.plugins)
        if (plugin.scope === "user")
          byId.set(plugin.id, { id: plugin.id, source: plugin.source.slice(0, SOURCE_MAX) });
      return { packages: [...byId.values()] };
    },
  };
}

export function agentsPackagesRpc(packages: AgentPackages): AgentsPackagesRpc {
  return { "agents.packages": async () => packages.list() };
}
