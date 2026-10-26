import { join, posix } from "node:path";
import { type BoxRef, boxKey, PapError, ProjectId, type VmLayout } from "@pap/contracts";
import type { ProjectBoxSource } from "./kernel/boxes.ts";
import { cleanLabel } from "./kernel/text.ts";
import type { Logger } from "./kernel/logger.ts";
import {
  type ClaudeTokens,
  type KataImages,
  layoutOf,
  createProjectImages,
  layoutOfSpec,
  projectLayoutOf,
  type VmSpec,
} from "./modules/agent-vm/index.ts";
import type { RequestItems } from "./modules/agents/index.ts";
import { type SessionBoxes, keepKeyOf, type SessionRow, taskKeyOf } from "./modules/sessions/index.ts";

/** What exists only after the projects module (daemon.ts binds it): the box source, and the project's name for the owner's words. */
export interface BoxesLate {
  readonly source: ProjectBoxSource;
  /** The project's name (the projects module's lookup), for the owner's Inbox; null when it finds none. */
  nameOf(ownerId: string, projectId: string): string | null;
  /** Posts a notice about the box (its image being rebuilt) into the project's live sessions; absent: logged. */
  notice?(projectId: string, text: string): void;
}

/** The one image tag of the tests' backends. */
export const TEST_IMAGE_TAG = `pap-agent-agent-${"0".repeat(64)}`;

/**
 * The project boxes in the VM composition (spec boxes, task A3): which layout a row or a VM spec has, where the sessions module
 * learns the boxes from, and what a box's launch is checked against. The source is bound late; until then no row is in a box and
 * a project box has no layout (fail closed).
 */
export function composeBoxes(
  home: string,
  logger: Logger,
  /** Kata's images, else null (the process backend or a test backend). */
  images: Pick<KataImages, "resolve" | "forget"> | null,
  /** The tests' own tag for every launch. */
  imageTagSeam?: (id: string) => string,
  /** The users' Claude tokens: a project box's bridge environment is given only while its owner's token is set. */
  claudeToken?: Pick<ClaudeTokens, "status">,
) {
  const backend = images === null ? "process" : "kata";
  // The image a project's box starts with: Kata resolves the profile's (task A6 replaces it with the project's own).
  let late: BoxesLate | null = null;
  // The tests' tag, else Kata's image policy, else the one test tag: always through the project's own packages (task A6).
  const imagePolicy: Pick<KataImages, "resolve" | "forget"> =
    imageTagSeam !== undefined
      ? { resolve: async (id) => imageTagSeam(id), forget: () => {} }
      : (images ?? { resolve: async () => TEST_IMAGE_TAG, forget: () => {} });
  const projectImages = createProjectImages({
    images: imagePolicy,
    logger,
    file: join(home, "vm", "project-images.json"),
    notice: (projectId, text) =>
      late?.notice ? late.notice(projectId, text) : logger.warn("box_notice_unbound", { projectId }),
  });
  const imageTagOf = projectImages.tagOf;
  let pause: (projectId: string) => void = (projectId) =>
    logger.error("box_vm_crash_pause_unwired", { box: boxKey({ kind: "project", id: projectId }) });
  const sessions: SessionBoxes = {
    projectOf(row) {
      // A cwd that is not its own normal form (`..`, `.`, a doubled slash) is never taken for a box's, whatever the source says.
      if (row.agentId !== undefined || late === null || posix.normalize(row.cwd) !== row.cwd) return null;
      const found = late.source.byPath(row.ownerId, row.cwd);
      // The id is a folder name under the box root and the mirrors: only a lowercase uuid is taken for one.
      return found !== null && ProjectId.safeParse(found.projectId).success ? found.projectId : null;
    },
    box: (projectId) => late?.source.box(projectId) ?? null,
    claudeTokenSet: (ownerId) => claudeToken?.status(ownerId) === "set",
    addHost: (projectId, host, actor) => late?.source.addHost(projectId, host, actor),
  };
  return {
    sessions,
    projectImages,
    bind(next: BoxesLate | null): void {
      late = next;
    },
    /** The row's layout: an agent's, or a project box's (the box exists), else null. */
    vmLayoutOf(row: SessionRow): VmLayout | null {
      if (row.agentId !== undefined)
        return layoutOf(backend, home, { agentId: row.agentId, taskKey: keepKeyOf(row) ?? taskKeyOf(row) });
      const projectId = sessions.projectOf(row);
      return projectId === null || sessions.box(projectId) === null
        ? null
        : projectLayoutOf(backend, home, projectId);
    },
    layoutOfSpec: (spec: Pick<VmSpec, "box" | "taskKey" | "keepKey">): VmLayout =>
      spec.box.kind === "project"
        ? projectLayoutOf(backend, home, spec.box.id)
        : layoutOfSpec(backend, home, spec),
    /** The deps of `createVmLaunch` that only a box uses. */
    launchDeps: {
      projectImageTagOf: imageTagOf,
      /** Called just before the VM starts: the project may have been deleted, or begun to be, while the image was built. */
      recheckProject(ownerId: string, projectId: string): void {
        const box = late?.source.box(projectId) ?? null;
        if (box === null || box.ownerId !== ownerId || box.deleting) throw new PapError("not_found");
      },
    },
    /** The runtime saw a VM exit three times in ten minutes (RT-40): an agent's pause is the agents module's, a box's is `pause`. */
    crashPause(box: BoxRef, agent: (agentId: string) => void): void {
      if (box.kind === "agent") agent(box.id);
      else pause(box.id);
    },
    /** Where a box's crash pause goes (the Inbox is built after this). Resuming it is `runtime.resume(box)`, the restart's (task A6). */
    bindCrashPause(handler: (projectId: string) => void): void {
      pause = handler;
    },
    source: (): ProjectBoxSource | null => late?.source ?? null,
    nameOf: (ownerId: string, projectId: string): string | null => late?.nameOf(ownerId, projectId) ?? null,
  };
}
export type Boxes = ReturnType<typeof composeBoxes>;

/** The longest project name kept as an item's subject. */
const NAME_UNITS = 80;

/**
 * RT-40 for a project box: the runtime refuses its launches (`agent_paused`) until the owner's restart resumes it, and the
 * owner is told once, in the Inbox, by a `box_paused` item: the subject is the project's name (its id when the lookup finds
 * none), it has no agent. Nothing is persisted: a restart of the daemon forgets the pause, like the runtime's own.
 */
export function createBoxCrashPause(deps: {
  readonly boxes: Pick<Boxes, "source" | "nameOf">;
  readonly items: Pick<RequestItems, "upsertAgentItem">;
  readonly logger: Pick<Logger, "warn">;
}): (projectId: string) => void {
  return (projectId) => {
    const ownerId = deps.boxes.source()?.box(projectId)?.ownerId ?? null;
    if (ownerId === null) {
      deps.logger.warn("box_vm_crash_pause_unknown_project", { projectId });
      return;
    }
    const name = cleanLabel(deps.boxes.nameOf(ownerId, projectId), NAME_UNITS) ?? projectId;
    deps.items.upsertAgentItem({
      ownerId,
      kind: "box_paused",
      agentId: null,
      title: name,
      // The project's id: a second pause of the same box refreshes this item, and the project's delete removes it (ruling R9).
      refId: projectId,
      detail: "La box s'est arrêtée trois fois en dix minutes ; elle est en pause.",
      toHandle: false,
    });
  };
}
