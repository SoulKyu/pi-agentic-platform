import { type Caller, PapError } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { Db } from "./kernel/db/database.ts";
import type { Logger } from "./kernel/logger.ts";
import type { BoxControl, ProjectBoxSource } from "./kernel/boxes.ts";
import type { AgentRuntime } from "./modules/agent-vm/index.ts";
import type { AgentsOwnerCascade, AgentsPort } from "./modules/agents/index.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import { type AuthModule, requireStepUp } from "./modules/auth/index.ts";
import type { AutomationOwnerCascade } from "./modules/automation/index.ts";
import type { ModelsPort } from "./modules/models/index.ts";
import { forgetPushOwner } from "./modules/push/index.ts";
import type { PreviewTokens } from "./modules/previews/index.ts";
import type { SearchModule } from "./modules/search/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";
import type { SessionsOwnerCascade } from "./modules/sessions/index.ts";
import type { ProjectsModule } from "./modules/projects/index.ts";
import type { RunsService } from "./modules/runs/index.ts";
import type { SettingsPort } from "./modules/settings/index.ts";
import { composeMemberLine, memberCapOf, type MemberLine } from "./compose-boxes-budget.ts";
import {
  createDeleteCascade,
  createDisabling,
  createProviderGate,
  createProviderKinds,
  createProviderSharing,
  createProvidersAdmin,
  createUsersService,
  type ProviderGate,
  providersRpc,
  usersAdminRpc,
  type ProvidersRpc,
  type UsersAdminRpc,
  USERS_MIGRATIONS,
} from "./modules/users/index.ts";

/** The users module's migration sources, spread into the daemon's list (`daemon.ts` stays at its cap). */
export const USERS_MIGRATION_SOURCES = [USERS_MIGRATIONS] as const;

/** The overview and the helper's list are read for the system, never for a folder: no cwd is named. */
const systemCaller: Caller = {
  userId: "users",
  permissions: new Set(),
  kind: "session",
  credentialId: "users",
  stepUpUntil: 0,
};

/** What exists only after the sessions, the settings, the runs and the agents (`bind`). */
export interface UsersLate {
  readonly runs: Pick<RunsService, "bindBudgetZone"> & {
    readonly port: Pick<RunsService["port"], "memberSpent" | "spentSince">;
  };
  readonly settings: { readonly port: Pick<SettingsPort, "automation"> };
  readonly boxes: {
    readonly control: Pick<BoxControl, "phase" | "stop">;
    readonly workspace: { readonly boxes: () => Pick<ProjectBoxSource, "ownerBoxes"> };
  };
  readonly agents: Pick<AgentsPort, "list">;
  readonly agentsVm: {
    readonly runtime: Pick<AgentRuntime, "phase">;
    readonly agentLink: { stop(agentId: string): Promise<void> };
  };
}

/** What a member's delete (A5b) reaches in the other modules, bound once they all exist. */
export interface UsersDeleteLate {
  readonly github: { releaseKeysOf(ownerId: string): Promise<number[]> };
  readonly projects: Pick<ProjectsModule, "removeAll">;
  readonly m11: { readonly agentsCascade: AgentsOwnerCascade };
  readonly m10Late: { readonly automation: { readonly ownerCascade: AutomationOwnerCascade } };
  readonly sessions: { readonly ownerCascade: SessionsOwnerCascade };
  readonly search: Pick<SearchModule, "dropOwner">;
  /** A disabled or deleted user's preview tokens die with the account (UX2-R72): the disable reaches them here too. */
  readonly previews: Pick<PreviewTokens, "revokeOwner">;
}

export interface ComposedUsers {
  readonly rpc: ProvidersRpc & UsersAdminRpc;
  /** What members may see and use of the owner's providers (policy models, `sessions.models`, `sessions.availableModels`). */
  readonly providers: ProviderGate;
  /** Binds the late modules and returns the member line (the budget gate and the disabled check of the relay's policy). */
  bind(late: UsersLate): MemberLine;
  /** The modules a member's delete reaches; a `users.delete` before then answers `internal`. */
  bindDelete(late: UsersDeleteLate): void;
}

/**
 * The shared providers (M14 A4b) and the users' administration (A5a). `models` is read when asked, because the models module is
 * composed after the sessions that need the gate. A switch refreshes every box's relay policy. The administration's own
 * dependencies are bound late; a call before then answers `internal`.
 */
export function composeUsers(
  core: {
    readonly db: Db;
    readonly clock: Clock;
    readonly logger: Logger;
    readonly audit: AuditPort;
    readonly config: { readonly home: string };
  },
  auth: AuthModule,
  relay: { refreshAll(): void } | null,
  models: () => Pick<ModelsPort, "overview" | "available">,
): ComposedUsers {
  const sharing = createProviderSharing({ db: core.db, roleOf: auth.roleOf });
  const kinds = createProviderKinds({
    overview: () => models().overview(systemCaller),
    clock: core.clock,
    logger: core.logger,
    onSeen: (provider, kind) => void sharing.stateOf(provider, kind),
  });
  const providers = createProviderGate({ roleOf: auth.roleOf, sharing, kinds, models });
  const admin = createProvidersAdmin({ sharing, kinds, refresh: () => relay?.refreshAll() });
  let bound: (UsersLate & { readonly line: MemberLine }) | null = null;
  let deleteLate: UsersDeleteLate | null = null;
  const late = () =>
    bound ??
    ((): never => {
      throw new PapError("internal");
    })();
  const capOf = memberCapOf(auth);
  const vault = createVaultStore(vaultRootOf(core.config.home), { sweep: false });
  const deleting = (): UsersDeleteLate =>
    deleteLate ??
    ((): never => {
      throw new PapError("internal");
    })();
  const cascade = createDeleteCascade({
    db: core.db,
    github: { releaseKeysOf: (ownerId) => deleting().github.releaseKeysOf(ownerId) },
    projects: { removeAll: (ownerId) => deleting().projects.removeAll(ownerId) },
    agents: { trashAll: (ownerId) => deleting().m11.agentsCascade.trashAll(ownerId) },
    automation: { removeAll: (ownerId) => deleting().m10Late.automation.ownerCascade.removeAll(ownerId) },
    sessions: { removeAll: (ownerId) => deleting().sessions.ownerCascade.removeAll(ownerId) },
    push: { forgetOwner: (ownerId) => forgetPushOwner(core.db, ownerId) },
    search: { dropOwner: (ownerId) => deleting().search.dropOwner(ownerId) },
    previews: { revokeOwner: (ownerId) => deleting().previews.revokeOwner(ownerId) },
    vault,
    auth: { deleteUser: (userId) => auth.deleteUser(userId) },
    logger: core.logger,
  });
  const service = createUsersService({
    clock: core.clock,
    audit: core.audit,
    auth,
    requireStepUp,
    capOf,
    usage: {
      spentToday: (userId) => late().line.memberSpentToday(userId),
      spentSince: (userId, since) => late().runs.port.spentSince(userId, since),
      boxesRunning(userId) {
        const { boxes, agents, agentsVm } = late();
        return (
          boxes.workspace
            .boxes()
            .ownerBoxes(userId)
            .filter((id) => boxes.control.phase(id) === "running").length +
          agents
            .list(userId)
            .filter((agent) => agentsVm.runtime.phase({ kind: "agent", id: agent.id }) === "running").length
        );
      },
    },
    disabling: createDisabling({
      boxes: {
        ownerBoxes: (userId) => late().boxes.workspace.boxes().ownerBoxes(userId),
        stop: (projectId) => late().boxes.control.stop(projectId),
      },
      agents: { list: (userId) => late().agents.list(userId) },
      stopAgent: (agentId) => late().agentsVm.agentLink.stop(agentId),
      previews: { revokeOwner: (ownerId) => deleting().previews.revokeOwner(ownerId) },
      logger: core.logger,
    }),
    cascade,
    refreshPolicies: () => relay?.refreshAll(),
  });
  return {
    rpc: { ...providersRpc(admin, core.audit), ...usersAdminRpc(service) },
    providers,
    bind(next) {
      const line = composeMemberLine({ auth, runs: next.runs, settings: next.settings.port });
      bound = { ...next, line };
      return line;
    },
    bindDelete(next) {
      deleteLate = next;
    },
  };
}
