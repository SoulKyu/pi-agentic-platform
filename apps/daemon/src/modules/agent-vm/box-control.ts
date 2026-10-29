import { type BoxPhase, type BoxRef, PapError, type PreviewDecl } from "@pap/contracts";
import type { BoxControl, BoxOps, ProjectBoxSource } from "../../kernel/boxes.ts";
import {
  imageStep,
  type LaunchHandle,
  type LaunchRegistry,
  launchCodeOf,
  stepAround,
} from "../../kernel/launches.ts";
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
  /** A launch of the box that this control did not ask for (a session's) also reads as `starting`, from its first step. */
  readonly launches: Pick<LaunchRegistry, "activeFor" | "onChange" | "open">;
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
  readonly gate: (box: BoxRef, launch?: Pick<LaunchHandle, "wait">) => Promise<void>;
}

/** The `for` of a launch that builds an image and starts nothing (R15). */
const REBUILD = "rebuild";
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
  const previews = new Map<string, { decl: PreviewDecl | null; invalid: boolean }>();

  const phaseOf = (projectId: string): BoxPhase => {
    const phase = runtime.phase(boxOf(projectId));
    if (phase === "running" || phase === "starting") return phase;
    // A build launch (a Rebuild) is no start: the box is not starting while its image is built in the background (R15).
    const active = deps.launches.activeFor(boxOf(projectId));
    return starting.has(projectId) || (active !== null && active.for !== REBUILD) ? "starting" : "stopped";
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

  const up = new Set<string>();
  runtime.onPhase((box) => {
    if (box.kind !== "project") return;
    tell(box.id);
    if (runtime.phase(box) !== "running") {
      up.delete(box.id);
      return;
    }
    if (!up.has(box.id)) {
      up.add(box.id);
      void refreshPreview(box.id);
    }
  });
  deps.launches.onChange((box) => {
    if (box.kind === "project") tell(box.id);
  });

  /**
   * The preview `.pi/project.yaml` declares, read when a box reaches `running` by any path (a session's launch included). A poll:
   * it never counts as activity and never starts a box; a failure keeps what was known (the next fresh read replaces it).
   */
  async function refreshPreview(projectId: string): Promise<void> {
    try {
      const config = await deps.ops.poll(projectId, { name: "project.config" });
      const row = deps.source()?.box(projectId) ?? null;
      if (row === null || row.deleting) return;
      previews.set(projectId, { decl: config.preview ?? null, invalid: config.previewInvalid === true });
    } catch {
      // A box that stopped again, or a guest that cannot answer: the cache keeps what it had.
    }
  }

  /** The packages `.pi/project.yaml` asks for, read through the box that is up; a failure keeps what was known, logged once. */
  async function readWanted(projectId: string): Promise<void> {
    try {
      const config = await deps.ops.call(projectId, { name: "project.config" });
      // The preview is recorded whatever the file says of its packages (UX2-R73): a file with a preview and no packages has one.
      previews.set(projectId, { decl: config.preview ?? null, invalid: config.previewInvalid === true });
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
    const owner = live().ownerId;
    if (runtime.phase(box) === "running") return;
    // Opened after the early return (a running box has no launch), ended on every other way out: done, refused, thrown.
    const launch = deps.launches.open({ box, owner, for: "start" });
    let code: string | undefined;
    try {
      await stepAround(launch, "checks", () => deps.gate(box, launch));
      const image = await imageStep(launch, (observe) => images.tagOf(projectId, observe));
      const row = live(); // the project may have been deleted while the image was built
      await runtime.start({ box, kind: "thread", taskKey: null, image, resources: row.resources, launch });
      await readWanted(projectId);
    } catch (error) {
      code = launchCodeOf(error);
      throw error;
    } finally {
      launch.end(code === undefined, code);
    }
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
        previews.delete(projectId);
        told.delete(projectId);
        up.delete(projectId);
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
        const owner = deps.source()?.box(projectId)?.ownerId;
        // A build launch: the image step only, so the Rebuild button, the activity list and the log have something to show.
        const launch =
          owner === undefined ? null : deps.launches.open({ box: boxOf(projectId), owner, for: REBUILD });
        let code: string | undefined;
        try {
          await imageStep(launch, (observe) => images.rebuild(projectId, running, observe));
        } catch (error) {
          code = launchCodeOf(error);
          throw error;
        } finally {
          launch?.end(code === undefined, code);
        }
      }),
    packages: (projectId) => images.packages(projectId),
    preview: (projectId) => previews.get(projectId) ?? { decl: null, invalid: false },
    notePreview: (projectId, decl, invalid) => void previews.set(projectId, { decl, invalid }),
    onPhase(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    rootOf: (projectId) => projectLayoutOf(deps.backend, deps.papHome, projectId).project,
  };
}
