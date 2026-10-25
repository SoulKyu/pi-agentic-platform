import { type BoxPhase, type BoxRef, PapError } from "@pap/contracts";
import type { BoxControl, BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import type { Logger } from "../../kernel/logger.ts";
import { projectLayoutOf } from "./layouts.ts";
import type { ProjectImages } from "./project-images.ts";
import type { AgentRuntime } from "./runtime.ts";
import { disposeProject, purgeProject, type TrashDeps } from "./trash.ts";

export interface BoxControlDeps {
  readonly runtime: Pick<
    AgentRuntime,
    "start" | "stop" | "resume" | "phase" | "onPhase" | "close" | "reopen"
  >;
  readonly ops: BoxOps;
  /** Late: the projects module is built after the VM stack; until it is bound no project has a box. */
  readonly source: () => ProjectBoxSource | null;
  readonly images: ProjectImages;
  readonly trash: TrashDeps;
  readonly papHome: string;
  readonly backend: "kata" | "process";
  readonly logger: Pick<Logger, "warn">;
  /**
   * What a launch checks before it starts a VM and a start checks too (pap-vmd and its bridge usable, the relay ready, the bundle
   * not stale): throws `sandbox_unavailable` or `vm_bundle_stale`. Capacity and `agent_paused` are the runtime's.
   */
  readonly gate: (box: BoxRef) => Promise<void>;
}

const boxOf = (projectId: string): BoxRef => ({ kind: "project", id: projectId });

/**
 * A project box's life for the projects module (spec boxes): start it with the guest only, restart it as a new launch, give it
 * the image of its packages, move it to the trash. The phase is what the runtime says, plus "starting" while the image is built
 * (a first build takes minutes and the runtime has no VM yet). Idle stop and crash pause are the runtime's.
 */
export function createBoxControl(deps: BoxControlDeps): BoxControl {
  const { runtime, images } = deps;
  const listeners = new Set<(projectId: string, phase: BoxPhase) => void>();
  const starting = new Map<string, Promise<void>>();
  const told = new Map<string, BoxPhase>();
  const unreadable = new Set<string>();

  const phaseOf = (projectId: string): BoxPhase => {
    const phase = runtime.phase(boxOf(projectId));
    if (phase === "running" || phase === "starting") return phase;
    return starting.has(projectId) ? "starting" : "stopped";
  };

  /** Each change once, whoever causes it (a start here, a session's launch, a crash, the idle stop). */
  function tell(projectId: string): void {
    const phase = phaseOf(projectId);
    if ((told.get(projectId) ?? "stopped") === phase) return;
    told.set(projectId, phase);
    for (const listener of [...listeners]) {
      try {
        listener(projectId, phase);
      } catch (error) {
        deps.logger.warn("box_phase_listener_failed", { projectId, err: error });
      }
    }
  }

  runtime.onPhase((box) => {
    if (box.kind === "project") tell(box.id);
  });

  /** The packages `.pi/project.yaml` asks for, read through the box that is up; a failure keeps what was known, logged once. */
  async function readWanted(projectId: string): Promise<void> {
    try {
      const config = await deps.ops.call(projectId, { name: "project.config" });
      if (config.error !== null || config.packages === null) throw new Error(config.error ?? "no packages");
      images.setWanted(projectId, config.packages);
      unreadable.delete(projectId);
    } catch (error) {
      if (unreadable.has(projectId)) return;
      unreadable.add(projectId);
      deps.logger.warn("box_project_config_unreadable", { projectId, err: error });
    }
  }

  async function bringUp(projectId: string): Promise<void> {
    const box = boxOf(projectId);
    const live = (): NonNullable<ReturnType<ProjectBoxSource["box"]>> => {
      const row = deps.source()?.box(projectId) ?? null;
      if (row === null || row.deleting) throw new PapError("not_found");
      return row;
    };
    live();
    if (runtime.phase(box) === "running") return;
    await deps.gate(box);
    const image = await images.tagOf(projectId);
    const row = live(); // the project may have been deleted while the image was built
    await runtime.start({ box, kind: "thread", taskKey: null, image, resources: row.resources });
    await readWanted(projectId);
  }

  /** One queue per box: a start, a restart, a rebuild and a dispose never overlap. */
  const tails = new Map<string, Promise<unknown>>();
  function inOrder<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const run = (tails.get(projectId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => {});
    tails.set(projectId, tail);
    void tail.then(() => {
      if (tails.get(projectId) === tail) tails.delete(projectId);
    });
    return run;
  }

  /** A start or a restart: "starting" shows from the call to the end, whatever waits before it. */
  function launch(projectId: string, work: () => Promise<void>): Promise<void> {
    const run: Promise<void> = inOrder(projectId, work).finally(() => {
      if (starting.get(projectId) === run) starting.delete(projectId);
      tell(projectId);
    });
    starting.set(projectId, run);
    tell(projectId);
    return run;
  }

  const start = (projectId: string): Promise<void> =>
    starting.get(projectId) ?? launch(projectId, () => bringUp(projectId));

  return {
    phase: phaseOf,
    start,
    restart: (projectId) =>
      launch(projectId, async () => {
        runtime.resume(boxOf(projectId));
        await runtime.stop(boxOf(projectId));
        await bringUp(projectId);
      }),
    stop: (projectId) => inOrder(projectId, () => runtime.stop(boxOf(projectId))),
    async dispose(projectId, stamp) {
      // Closed first and at once: a restart or a session's spawn that lands from now on is refused, whatever is queued.
      runtime.close(boxOf(projectId));
      await inOrder(projectId, async () => {
        await runtime.stop(boxOf(projectId));
        await disposeProject(deps.trash, projectId, stamp);
        images.forget(projectId);
        told.delete(projectId);
        unreadable.delete(projectId);
      });
    },
    async purge(projectId) {
      await purgeProject(deps.trash, projectId);
      runtime.reopen(boxOf(projectId));
    },
    rebuild: (projectId) =>
      inOrder(projectId, async () => {
        const running = runtime.phase(boxOf(projectId)) === "running";
        if (running) await readWanted(projectId); // an edit since the start
        await images.rebuild(projectId, running);
      }),
    packages: (projectId) => images.packages(projectId),
    onPhase(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    rootOf: (projectId) => projectLayoutOf(deps.backend, deps.papHome, projectId).project,
  };
}
