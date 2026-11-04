import type { BoxRef } from "@pap/contracts";
import type { BoxControl, ProjectBoxSource } from "./kernel/boxes.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type AgentRuntime,
  type AlwaysOnBox,
  type AlwaysOnHooks,
  createAlwaysOnKeeper,
} from "./modules/agent-vm/index.ts";
import type { AgentsPort } from "./modules/agents/index.ts";
import type { AuthModule } from "./modules/auth/index.ts";
import type { ProjectsPort } from "./modules/projects/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";

/** What the keeper reads and drives, once the modules exist; a subset of what the Overview composition gathers. */
export interface AlwaysOnComposition {
  readonly logger: Logger;
  readonly closers: Array<{ readonly name: string; close(): void | Promise<void> }>;
  readonly auth: Pick<AuthModule, "ownerId" | "users" | "isDisabled">;
  readonly agentsVm: {
    readonly runtime: Pick<AgentRuntime, "bindAlwaysOn" | "refreshIdle">;
    startAgent(ownerId: string, agentId: string): Promise<void>;
  };
  readonly m11: { readonly agents: Pick<AgentsPort, "list" | "get" | "onChange"> };
  readonly sessions: Pick<SessionsModule, "bindKeepWorker" | "touchIdle">;
  readonly projects: { readonly port: Pick<ProjectsPort, "onAlwaysOnChange"> };
  readonly boxes: {
    readonly control: Pick<BoxControl, "start">;
    readonly workspace: { readonly boxes: () => Pick<ProjectBoxSource, "ownerBoxes" | "box"> };
  };
}

/**
 * Always-on boxes (decision 149): the boxes that must be up, the idle hold and exit restart the runtime asks for, the
 * worker hold the sessions ask for, and the reaction when a switch is turned off. `start()` runs once the server listens.
 */
export function composeAlwaysOn(modules: AlwaysOnComposition): { start(): void } {
  const { auth, agentsVm, m11, sessions, projects, boxes, logger } = modules;
  const { runtime } = agentsVm;
  const agents = m11.agents;

  // R3: the owner's boxes first, then each member's in `auth.users` order; agents before projects. R4: what is skipped.
  const wanted = (): AlwaysOnBox[] => {
    const ownerId = auth.ownerId();
    const ids = auth.users().map((user) => user.id);
    const ordered = ownerId === null ? ids : [ownerId, ...ids.filter((id) => id !== ownerId)];
    const source = boxes.workspace.boxes();
    return ordered
      .filter((id) => !auth.isDisabled(id))
      .flatMap((ownerId) => [
        ...agents
          .list(ownerId)
          .filter((a) => a.input?.alwaysOn === true && !a.paused && a.quarantinedAt === null)
          .map((a): AlwaysOnBox => ({ ownerId, box: { kind: "agent", id: a.id } })),
        ...source
          .ownerBoxes(ownerId)
          .filter((id) => {
            const row = source.box(id);
            return row !== null && row.alwaysOn && !row.deleting;
          })
          .map((id): AlwaysOnBox => ({ ownerId, box: { kind: "project", id } })),
      ]);
  };

  const keeper = createAlwaysOnKeeper({
    boxes: wanted,
    start: ({ box, ownerId }) =>
      box.kind === "agent" ? agentsVm.startAgent(ownerId, box.id) : boxes.control.start(box.id),
    logger,
  });
  const hooks: AlwaysOnHooks = { holds: keeper.holds, exited: keeper.exited };
  runtime.bindAlwaysOn(hooks);

  let keepFailureLogged = false;
  sessions.bindKeepWorker((ownerId, sessionId) => {
    try {
      return agents
        .list(ownerId)
        .some((a) => a.threadSessionId === sessionId && a.input?.alwaysOn === true && !a.paused);
    } catch (error) {
      if (!keepFailureLogged) {
        keepFailureLogged = true;
        logger.warn("always_on_hold_failed", { err: error });
      }
      return false;
    }
  });

  // The last `{alwaysOn, paused}` of each agent, to see a switch turned off (R2) or a resume (R6).
  const held = (state: { alwaysOn: boolean; paused: boolean }): boolean => state.alwaysOn && !state.paused;
  const last = new Map<string, { alwaysOn: boolean; paused: boolean }>();
  for (const user of auth.users())
    for (const a of agents.list(user.id))
      last.set(a.id, { alwaysOn: a.input?.alwaysOn === true, paused: a.paused });
  const stops = [
    agents.onChange(({ ownerId, agentId, removed }) => {
      if (removed) {
        last.delete(agentId);
        return;
      }
      const record = agents.get(ownerId, agentId);
      if (record === null) return;
      const now = { alwaysOn: record.input?.alwaysOn === true, paused: record.paused };
      const before = last.get(agentId);
      last.set(agentId, now);
      const box: BoxRef = { kind: "agent", id: agentId };
      // A switch turned off, or an always-on agent paused: its workerless VM must be able to stop again.
      if (before !== undefined && held(before) && !held(now)) {
        runtime.refreshIdle(box);
        if (record.threadSessionId !== null) sessions.touchIdle(ownerId, record.threadSessionId);
      }
      // R6: resuming an always-on agent starts its box; `exited` starts a listed box, as after an exit.
      if (before?.paused === true && !now.paused && now.alwaysOn) keeper.exited(box);
    }),
    projects.port.onAlwaysOnChange(({ projectId, alwaysOn }) => {
      if (!alwaysOn) runtime.refreshIdle({ kind: "project", id: projectId });
    }),
  ];
  modules.closers.push({
    name: "always_on",
    close() {
      keeper.close();
      for (const stop of stops.splice(0)) stop();
    },
  });

  return { start: () => void keeper.bootStart() };
}
