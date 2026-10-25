import type { BoxRef, Caller } from "@pap/contracts";
import type { IsMember } from "./kernel/box-path.ts";
import type { BoxControl, BoxOps, BoxTerminals, ProjectBoxSource } from "./kernel/boxes.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import { type ClientPathGate, createClientPathGate } from "./kernel/ws/client-path-gate.ts";
import type { Boxes, BoxesLate } from "./compose-boxes.ts";
import {
  createBoxControl,
  createBoxOps,
  createBoxTerminals,
  type AgentRuntime,
  type VmdClient,
} from "./modules/agent-vm/index.ts";
import { removeTree } from "./modules/agents/index.ts";
import type { Inbox } from "./modules/inbox/index.ts";
import type { ProjectsModule } from "./modules/projects/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { AutomationModule } from "./modules/automation/index.ts";

/** What the VM composition hands the boxes: the pieces of the stack only it holds (Kata's client, the launch gate). */
export interface BoxStack {
  readonly backend: "kata" | "process";
  /** pap-vmd; null under the process backend, which has no disk of its own to trash. */
  readonly client: VmdClient | null;
  /** The checks a launch makes before it starts a VM (the stack usable, the relay ready, the bundle not stale). */
  gate(box: BoxRef): Promise<void>;
}

/** The notices the image policy writes for an agent, in the words of a box (the owner reads them in the project's sessions). */
const PROJECT_NOTICES: ReadonlyMap<string, string> = new Map([
  [
    "Une nouvelle image est en préparation ; cet agent tourne sur l'ancienne.",
    "Une nouvelle image est en préparation ; cette box tourne sur l'ancienne.",
  ],
  [
    "Cet agent doit être reconstruit pour cette version de pap ; il redémarrera quand l'image sera prête.",
    "Cette box doit être reconstruite pour cette version de pap ; elle redémarrera quand l'image sera prête.",
  ],
  [
    "Les secrets du coffre et de Pi sont trop nombreux pour être vérifiés ; l'image de l'agent n'est pas construite.",
    "Les secrets du coffre et de Pi sont trop nombreux pour être vérifiés ; l'image de la box n'est pas construite.",
  ],
]);
export const projectNoticeOf = (text: string): string => PROJECT_NOTICES.get(text) ?? text;

export interface BoxWiringDeps {
  readonly vm: {
    readonly runtime: AgentRuntime;
    readonly boxes: Boxes;
    readonly boxStack: BoxStack;
    resourceHost(): { memoryCapMb: number; cores: number };
  };
  readonly projects: Pick<ProjectsModule, "boxSource" | "port" | "bindBoxes">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly home: string;
  readonly isMember: IsMember;
  requireStepUp(caller: Caller, now: number): void;
}

/** What the files and vcs modules are given: late getters (their bed shape), bound at once. */
export interface WorkspaceBoxes {
  readonly boxes: () => ProjectBoxSource;
  readonly boxOps: () => BoxOps;
  readonly boxControl: () => BoxControl;
  readonly boxTerminals: () => BoxTerminals;
  readonly isMember: IsMember;
  /** The walk over a request's client paths: a member's request carries box paths only (M14). */
  readonly gate: ClientPathGate;
}

export interface BoxWiring {
  readonly ops: BoxOps;
  readonly control: BoxControl;
  readonly workspace: WorkspaceBoxes;
  /**
   * Once the sessions, the automation and the Inbox exist: the projects module gets its control, ops and cleanups, and the
   * VM composition's late binding gets the project part (`late.boxes`).
   */
  bind(modules: {
    readonly sessions: Pick<SessionsModule, "projectCleanup" | "mirror">;
    readonly automation: Pick<AutomationModule, "projectPort">;
    readonly inbox: Pick<Inbox, "agentItems">;
  }): BoxesLate;
}

/** The kind of the Inbox item a crash pause leaves (`refId` is the project): a delete removes it. */
const PAUSED_KIND = "box_paused";

/**
 * The project boxes of lot B1 (spec boxes): the guest ops, the box control, and the source of the owner's box projects given
 * to every module that must tell a box path from a host path. The source exists with the projects module, so it is bound to
 * the VM composition here, before the sessions, the automation or the files modules are built: no call can meet a box root
 * while the source is still missing (it would be a host path). `bind` follows once the modules the projects module cleans up
 * after exist.
 */
export function composeBoxWiring(deps: BoxWiringDeps): BoxWiring {
  const { vm, projects, logger } = deps;
  const source = projects.boxSource;
  const ops = createBoxOps(vm.runtime, deps.clock);
  const terminals = createBoxTerminals(vm.runtime);
  const control = createBoxControl({
    runtime: vm.runtime,
    ops,
    source: () => source,
    images: vm.boxes.projectImages,
    trash: {
      client: vm.boxStack.client,
      papHome: deps.home,
      clock: deps.clock,
      logger: logger.child({ module: "agent-vm" }),
      remove: removeTree,
    },
    papHome: deps.home,
    backend: vm.boxStack.backend,
    logger,
    gate: vm.boxStack.gate,
  });
  let cleanup: Pick<SessionsModule, "projectCleanup" | "mirror"> | null = null;
  const late: BoxesLate = {
    source,
    nameOf: (ownerId, projectId) => projects.port.list(ownerId, [projectId])[0]?.name ?? null,
    notice(projectId, text) {
      const ownerId = source.box(projectId)?.ownerId ?? null;
      if (ownerId === null || cleanup === null) {
        logger.warn("box_notice_no_session", { projectId });
        return;
      }
      for (const sessionId of cleanup.projectCleanup.liveIds(ownerId, projectId))
        cleanup.mirror.notice(sessionId, projectNoticeOf(text));
    },
  };
  vm.boxes.bind(late);
  return {
    ops,
    control,
    workspace: {
      boxes: () => source,
      boxOps: () => ops,
      boxControl: () => control,
      boxTerminals: () => terminals,
      isMember: deps.isMember,
      gate: createClientPathGate({ isMember: deps.isMember, boxes: () => source }),
    },
    bind({ sessions, automation, inbox }) {
      cleanup = sessions;
      projects.bindBoxes({
        control,
        ops,
        sessions: {
          count: sessions.projectCleanup.count,
          async removeProject(ownerId, projectId) {
            const removed = await sessions.projectCleanup.removeProject(ownerId, projectId);
            inbox.agentItems.removeRef(ownerId, PAUSED_KIND, projectId);
            return removed;
          },
        },
        automation: automation.projectPort,
        requireStepUp: deps.requireStepUp,
        resourceHost: vm.resourceHost,
      });
      return late;
    },
  };
}
