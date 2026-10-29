import {
  type BoxPhase,
  type Caller,
  DEFAULT_PROJECT_RESOURCES,
  type ParamsOf,
  PapError,
  type ProjectBoxView,
  SHELL_LIMITS,
} from "@pap/contracts";
import type { BoxControl, BoxOps } from "../../kernel/boxes.ts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import type { Logger } from "../../kernel/logger.ts";
import { checkAgentResources } from "../../kernel/resources-check.ts";
import { cleanLabel } from "../../kernel/text.ts";
import type { AuditPort } from "../audit/index.ts";
import type { BoxRecord, BoxStore } from "./box-store.ts";
import { MAX_PROJECTS } from "./limits.ts";
import type { ProjectRow, ProjectsStore } from "./store.ts";
import type { ProjectView } from "./service.ts";

export const SCRATCH_NAME = "Scratch";

/** What the sessions or the automation module does for a box project's delete: how many it holds, and removing them all. */
export interface ProjectCleanup<K extends "sessions" | "triggers"> {
  count(ownerId: string, projectId: string): number;
  removeProject(ownerId: string, projectId: string): Promise<{ readonly [P in K]: number }>;
}

/** What the composition gives once the real box control exists (J1); until then the box methods answer `internal`. */
export interface ProjectBoxWiring {
  readonly control: BoxControl;
  /** The guest ops: a box project's knowledge is asked of its guest. */
  readonly ops: BoxOps;
  readonly sessions: ProjectCleanup<"sessions">;
  readonly automation: ProjectCleanup<"triggers">;
  requireStepUp(caller: Caller, now: number): void;
  /** The host's ceilings for one box (the agents' check); none: only the rule that the disk only grows. */
  resourceHost?(): { memoryCapMb: number; cores: number };
}

type Params<M extends "projects.setBox"> = ParamsOf<M>;

export function createBoxService(deps: {
  readonly store: ProjectsStore;
  readonly boxes: BoxStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly audit?: Pick<AuditPort, "append">;
  newId(): string;
  /** Tells the shell stream (the projects service's listeners). */
  changed(ownerId: string, project: ProjectView): void;
  /** Tells the shell stream the project is gone (the projects service's removal listeners). */
  removed(ownerId: string, projectId: string): void;
  owned(ownerId: string, id: string): ProjectRow;
}) {
  let wiring: ProjectBoxWiring | undefined;
  const wired = (): ProjectBoxWiring => {
    if (wiring === undefined) throw new PapError("internal");
    return wiring;
  };
  const phaseOf = (projectId: string): BoxPhase => wiring?.control.phase(projectId) ?? "stopped";

  function viewOf(row: ProjectRow): ProjectView {
    const base = { id: row.id, root: row.root, name: row.name, position: row.position };
    // A host project is as it always was: no `kind` on the wire.
    if (row.kind !== "box") return base;
    const record = deps.boxes.get(row.id);
    return {
      ...base,
      kind: "box",
      ...(record?.scratch ? { scratch: true as const } : {}),
      box: { phase: phaseOf(row.id) },
    };
  }

  const boxOf = (ownerId: string, projectId: string): BoxRecord => {
    deps.owned(ownerId, projectId);
    const record = deps.boxes.get(projectId);
    if (!record) throw new PapError("not_found");
    return record;
  };
  /** A box that can be changed or started: one being deleted is gone as far as the gate is concerned. */
  const liveBoxOf = (ownerId: string, projectId: string): BoxRecord => {
    const record = boxOf(ownerId, projectId);
    if (record.deleting) throw new PapError("not_found");
    return record;
  };
  const audit = (caller: Caller, reason: string, projectId: string): void =>
    deps.audit?.append({
      ownerId: caller.userId,
      actor: caller.kind === "token" ? "token" : "user",
      ...(caller.kind === "token" && caller.credentialId ? { actorId: caller.credentialId } : {}),
      kind: "policy",
      reason,
      detail: { projectId },
    });
  const hostFor = (): { memoryCapMb: number; cores: number } =>
    wired().resourceHost?.() ?? { memoryCapMb: Number.POSITIVE_INFINITY, cores: Number.POSITIVE_INFINITY };

  function make(caller: Caller, name: string, scratch: boolean): ProjectView {
    const { control } = wired();
    const ownerId = caller.userId;
    if (deps.store.count(ownerId) >= MAX_PROJECTS) throw new PapError("capacity");
    // A new box: the defaults must fit this host before any row is written.
    checkAgentResources(DEFAULT_PROJECT_RESOURCES, null, hostFor(), deps.logger);
    const id = deps.newId();
    const row: ProjectRow = {
      id,
      ownerId,
      root: control.rootOf(id),
      name,
      position: (deps.store.firstPosition(ownerId) ?? 0) - 1,
      createdAt: deps.clock.now(),
      kind: "box",
    };
    try {
      deps.store.transaction(() => {
        deps.store.insert(row);
        deps.boxes.insert({ projectId: id, resources: DEFAULT_PROJECT_RESOURCES, hosts: [], scratch });
      });
    } catch (error) {
      throw isReadOnlyError(error) ? new PapError("read_only") : error;
    }
    audit(caller, "project_box_created", id);
    const view = viewOf(row);
    deps.changed(ownerId, view);
    return view;
  }

  const countsOf = (ownerId: string, projectId: string) => ({
    sessions: wiring?.sessions.count(ownerId, projectId) ?? 0,
    triggers: wiring?.automation.count(ownerId, projectId) ?? 0,
  });
  function boxView(record: BoxRecord): ProjectBoxView {
    const packages = wiring?.control.packages(record.projectId) ?? { built: [], wanted: null };
    const preview = wiring?.control.preview(record.projectId) ?? { decl: null, invalid: false };
    return {
      phase: phaseOf(record.projectId),
      resources: record.resources,
      hosts: [...record.hosts],
      packages: {
        built: [...packages.built],
        wanted: packages.wanted === null ? null : [...packages.wanted],
      },
      scratch: record.scratch,
      preview: preview.decl,
      ...(preview.invalid ? { previewInvalid: true as const } : {}),
      counts: countsOf(record.ownerId, record.projectId),
    };
  }
  const republish = (record: BoxRecord): void => {
    const row = deps.store.get(record.ownerId, record.projectId);
    if (row) deps.changed(record.ownerId, viewOf(row));
  };
  const lifecycle =
    (act: (control: BoxControl, projectId: string) => Promise<void>) =>
    async (caller: Caller, projectId: string): Promise<{ ok: true }> => {
      const { control } = wired();
      liveBoxOf(caller.userId, projectId);
      await act(control, projectId);
      return { ok: true };
    };

  /**
   * The project is marked `deleting`, its tasks and triggers go, then its sessions, then the box stops and its disk goes to
   * the trash, then the rows: a failure in between leaves the mark, and a retry finishes the job.
   */
  async function dispose(ownerId: string, projectId: string): Promise<void> {
    const { control, sessions, automation } = wired();
    try {
      deps.boxes.markDeleting(projectId);
    } catch (error) {
      throw isReadOnlyError(error) ? new PapError("read_only") : error;
    }
    // Tasks first: cancelled while their workers still run they end `cancelled`; after the box is down they would end
    // `interrupted`, a state the board offers to retry. Then the sessions, then the box and its disk.
    await automation.removeProject(ownerId, projectId);
    await sessions.removeProject(ownerId, projectId);
    await control.dispose(projectId, deps.clock.now());
    deps.boxes.remove(projectId);
    deps.removed(ownerId, projectId);
  }

  return {
    viewOf,
    /** The wiring once bound (the knowledge of a box project reads its control and ops). */
    wiring: (): ProjectBoxWiring | undefined => wiring,
    /** From the composition, once the real box control exists: the box phase then reaches the shell stream. */
    bind(next: ProjectBoxWiring): void {
      wiring = next;
      next.control.onPhase((projectId) => {
        const record = deps.boxes.get(projectId);
        if (record) republish(record);
      });
    },
    create(caller: Caller, name: string): ProjectView {
      wired();
      const clean = cleanLabel(name, SHELL_LIMITS.projectName);
      if (clean === null) throw new PapError("bad_request");
      return make(caller, clean, false);
    },
    scratch(caller: Caller): ProjectView {
      wired();
      const found = deps.boxes.scratchOf(caller.userId);
      const row = found && deps.store.get(caller.userId, found.projectId);
      return row ? viewOf(row) : make(caller, SCRATCH_NAME, true);
    },
    box: (caller: Caller, projectId: string): ProjectBoxView => boxView(boxOf(caller.userId, projectId)),
    setBox(caller: Caller, input: Params<"projects.setBox">): ProjectBoxView {
      wired();
      const record = liveBoxOf(caller.userId, input.projectId);
      if (input.resources) checkAgentResources(input.resources, record.resources, hostFor(), deps.logger);
      try {
        deps.boxes.set(record.projectId, {
          ...(input.resources ? { resources: input.resources } : {}),
          ...(input.hosts ? { hosts: input.hosts } : {}),
        });
      } catch (error) {
        throw isReadOnlyError(error) ? new PapError("read_only") : error;
      }
      audit(caller, "project_box_changed", record.projectId);
      return boxView(boxOf(caller.userId, input.projectId));
    },
    start: lifecycle((control, projectId) => control.start(projectId)),
    restart: lifecycle((control, projectId) => control.restart(projectId)),
    /** A failed image build is `command_failed` (the control logged it once): the box and its packages stay as they were. */
    rebuild: lifecycle(async (control, projectId) => {
      try {
        await control.rebuild(projectId);
      } catch (error) {
        if (error instanceof PapError) throw error;
        deps.logger.warn("project_rebuild_failed", { projectId, err: error });
        throw new PapError("command_failed");
      }
    }),
    /**
     * Step-up first. The project is marked `deleting`, its tasks and triggers go, then its sessions, then the box stops and
     * its disk goes to the trash, then the rows: a failure in between leaves the mark, and a retry finishes the job. Scratch with
     * sessions is a `conflict`.
     */
    async remove(caller: Caller, projectId: string): Promise<{ ok: true }> {
      const { sessions, requireStepUp } = wired();
      requireStepUp(caller, deps.clock.now());
      const record = boxOf(caller.userId, projectId);
      if (record.scratch && sessions.count(caller.userId, projectId) > 0) throw new PapError("conflict");
      await dispose(caller.userId, projectId);
      audit(caller, "project_box_deleted", projectId);
      return { ok: true };
    },
    /**
     * A member's delete (A5b): every box project of the owner goes to the trash as `remove` does it, with no caller and no
     * step-up (the delete asked it for the account). The scratch box goes with its sessions, which a delete does not refuse.
     * The first failure is thrown, the mark `deleting` stays, and a retry finishes the job. Returns how many.
     */
    async removeAll(ownerId: string): Promise<number> {
      wired();
      const records = deps.boxes.ofOwner(ownerId);
      for (const record of records) {
        await dispose(ownerId, record.projectId);
        deps.audit?.append({
          ownerId,
          actor: "system",
          kind: "policy",
          reason: "project_box_deleted",
          detail: { projectId: record.projectId },
        });
      }
      return records.length;
    },
  };
}
