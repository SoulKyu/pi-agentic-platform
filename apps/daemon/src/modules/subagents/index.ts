import { fileURLToPath } from "node:url";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { PlatformHandler } from "../platform/index.ts";
import type { RunsPort } from "../runs/index.ts";
import type { SessionsModule } from "../sessions/index.ts";
import { createProfileReader } from "./profile.ts";
import { createProfiles, type ProfilesDeps, type SubagentsPi } from "./profiles.ts";
import { type SubagentRuns, createSubagentService } from "./service.ts";
import { type SubagentsRpc, subagentsRpc } from "./rpc.ts";
import { createSubagentStop } from "./stop.ts";
import { createSubagentStore } from "./store.ts";

export { createAgentOver } from "./budget.ts";
export type { SubagentsRpc };

export const SUBAGENTS_MIGRATIONS: MigrationSource = {
  module: "subagents",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

/** The Pi modules (helper pool, trust) and the sessions the profiles are read for and the children are made in. */
export interface SubagentsPorts {
  readonly pi: SubagentsPi;
  readonly sessions: Pick<SessionsModule, "cwdOf" | "isAgentSession" | "child" | "automation" | "kindOf">;
}

export interface SubagentsModuleDeps {
  readonly ports: SubagentsPorts;
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
  newId(): string;
  readonly settings: {
    subagents(ownerId: string): { readonly enabled: boolean; readonly maxConcurrent: number };
  };
  readonly runs: SubagentRuns & Pick<RunsPort, "sessionCost">;
  readonly agents: { over(ownerId: string, agentId: string): boolean };
}

export interface SubagentsModule {
  readonly rpc: SubagentsRpc;
  /** The `subagent.run` handler and its switch, for the platform port (M11R137). */
  readonly op: PlatformHandler<"subagent.run">;
  enabled(ownerId: string): boolean;
  /** Quarantine step 2 (M11R139 d): aborts every running child of the agent's threads; how many. */
  cancelAgent(ownerId: string, agentId: string): number;
  /** A child of the agent's thread waits for the owner: the rail reads it (M11R140). */
  childWaiting(ownerId: string, agentId: string): boolean;
  /** First in the daemon's stop: the retries of a worker release are cleared. */
  stop(): void;
}

export function createSubagentsModule(deps: SubagentsModuleDeps): SubagentsModule {
  const logger = deps.logger.child({ module: "subagents" });
  const profileDeps: ProfilesDeps = { pi: deps.ports.pi, sessions: deps.ports.sessions, logger };
  const store = createSubagentStore(deps.db);
  const { sessions } = deps.ports;
  const stop = createSubagentStop({
    clock: deps.clock,
    logger,
    store,
    sessions: {
      abort: sessions.automation.abort,
      agentOf: (parentId) => sessions.kindOf(parentId)?.agentId ?? null,
    },
    runs: deps.runs,
  });
  // (e) No child survives a daemon that stopped: a row left live would count against its parent for ever (a read-only database writes nothing).
  if (!deps.readOnly) stop.boot();
  // (b) the parent's run end, (c) its archive or deletion.
  stop.watch(deps.runs.onRunEnd);
  sessions.child.onGone(
    (sessionId, why) =>
      void stop.cancelParent(sessionId, why === "archived" ? "parent_archived" : "parent_deleted"),
  );
  // The parent's screen lists its newest children with the cost each one's runs stored (M11R140, M11R141).
  sessions.child.setSource({
    childrenOf: (ownerId, parentId, limit) =>
      store
        .childrenOf(parentId, limit)
        .filter((row) => row.ownerId === ownerId && row.childSessionId !== null)
        .map((row) => ({
          id: row.childSessionId as string,
          runId: row.id,
          title: row.title,
          profile: row.profile,
          state: row.state,
          costUsd: deps.runs.sessionCost(row.childSessionId as string) ?? 0,
        })),
  });
  const service = createSubagentService({
    clock: deps.clock,
    logger,
    newId: deps.newId,
    store,
    settings: deps.settings,
    profiles: createProfileReader(profileDeps),
    sessions: {
      admits: sessions.child.admits,
      createChild: ({ ownerId, parentSessionId, profile }) =>
        sessions.child.createChildSession({ ownerId, parentSessionId, profile }),
      prompt: (input) => sessions.automation.prompt(input),
      abort: sessions.automation.abort,
      lastText: sessions.child.lastText,
      taintedOf: (sessionId) => sessions.kindOf(sessionId)?.tainted ?? null,
      releaseIdle: sessions.automation.releaseIdle,
      parentOpen: sessions.child.parentOpen,
      changed: sessions.child.refresh,
    },
    runs: deps.runs,
    agents: deps.agents,
    stop,
  });
  return {
    rpc: subagentsRpc(createProfiles(profileDeps), stop.cancelRun),
    op: service.run,
    enabled: service.enabled,
    cancelAgent: stop.cancelAgent,
    childWaiting: sessions.child.waitingAgent,
    stop: service.stop,
  };
}
