import type { Clock } from "../../kernel/clock.ts";
import type { AuditPort } from "../audit/index.ts";
import { createPermissions, type PermissionsDeps } from "./permissions.ts";
import { createPrompts } from "./prompts.ts";
import { createQuarantine, type QuarantineDeps } from "./quarantine.ts";
import type { AgentSafetyServices } from "./rpc.ts";
import type { AgentStore } from "./store.ts";

export interface AgentSafetyDeps {
  readonly store: AgentStore;
  readonly links: PermissionsDeps["links"];
  readonly lock: QuarantineDeps["lock"];
  readonly guard: QuarantineDeps["guard"];
  readonly clock: Clock;
  readonly logger: QuarantineDeps["logger"];
  readonly audit: Pick<AuditPort, "append">;
  readonly requireStepUp: QuarantineDeps["requireStepUp"];
  readonly changed: QuarantineDeps["changed"];
  readonly papHome: string;
  readonly sandboxUsable: PermissionsDeps["sandboxUsable"];
  /** The owner's settings (their host list and blocked commands); undefined when the policy module is absent. */
  ownerSettings(
    ownerId: string,
  ): { readonly allowHosts: readonly string[] | null; readonly denylist: readonly unknown[] } | undefined;
  readonly liveTools: PermissionsDeps["liveTools"];
  readonly hostGrants: PermissionsDeps["hostGrants"];
}

/** Task 21's three services behind `agents.quarantine`, `agents.permissions` and `agents.prompts`. */
export function createAgentSafety(deps: AgentSafetyDeps): AgentSafetyServices {
  return {
    quarantine: createQuarantine(deps),
    permissions: createPermissions({
      ...deps,
      ownerPolicy: (ownerId) => {
        const owner = deps.ownerSettings(ownerId);
        return { allowHosts: owner?.allowHosts ?? null, blocked: owner?.denylist.length ?? 0 };
      },
    }),
    prompts: createPrompts(deps),
  };
}
