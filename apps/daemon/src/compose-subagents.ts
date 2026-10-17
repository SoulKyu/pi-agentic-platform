import { newId } from "./kernel/ids.ts";
import type { M11Core, M11Modules } from "./compose-m11.ts";
import type { PlatformPort } from "./modules/platform/index.ts";
import type { AgentSpend, RunsPort } from "./modules/runs/index.ts";
import { createAgentOver, createSubagentsModule } from "./modules/subagents/index.ts";

/** What the M11 entry reads of the runs registry: run starts and ends, the origin of a child's runs, the cost it rolls up. */
export type M11RunsPort = Pick<
  RunsPort,
  "onRunStart" | "onRunEnd" | "expectOrigin" | "clearExpected" | "openTaskOf" | "sessionCost"
>;

/** What the subagents module reads of the agents registry: the profile's budget now, and the runs registry's spend. */
interface AgentFacts {
  budgetOf: Parameters<typeof createAgentOver>[0]["budgetOf"];
  readonly spend: Pick<AgentSpend, "agentSpentToday">;
}

/**
 * The subagents module (Task 29b) and its op on the platform port, with the owner's switch (owner m12): read at every worker
 * start and every call, so a switch turned off removes the tool at the next worker start (M11R36).
 */
export function composeSubagents(
  core: Pick<M11Core, "db" | "clock" | "logger" | "readOnly">,
  modules: Pick<M11Modules, "subagents" | "settings" | "runs">,
  platform: Pick<PlatformPort, "register">,
  agents: AgentFacts,
) {
  const subagents = createSubagentsModule({
    ports: modules.subagents,
    db: core.db,
    clock: core.clock,
    logger: core.logger,
    readOnly: core.readOnly,
    newId,
    settings: { subagents: (ownerId) => modules.settings.port.agents(ownerId).subagents },
    runs: modules.runs,
    agents: {
      over: createAgentOver({
        budgetOf: agents.budgetOf,
        spend: agents.spend,
        timeZone: (ownerId) => modules.settings.port.automation(ownerId).timezone,
      }),
    },
  });
  platform.register("subagent.run", subagents.op, { enabled: subagents.enabled });
  return subagents;
}
