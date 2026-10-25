import { BoxRef } from "@pap/contracts";
import type { ProjectBoxSource } from "../../kernel/boxes.ts";
import type { LaunchRegistry } from "../../kernel/launches.ts";
import type { TaskRow } from "./tasks.ts";

/** How long a task whose box builds its image waits before it asks again. */
export const IMAGE_BUILD_MS = 10_000;

/** The box a task runs in: an agent's own, or the box project its folder is in; null for a host project. */
export function taskBoxOf(boxes: Pick<ProjectBoxSource, "byPath"> | undefined, row: TaskRow): BoxRef | null {
  const ref =
    row.agent_id !== null
      ? { kind: "agent", id: row.agent_id }
      : { kind: "project", id: boxes?.byPath(row.owner_id, row.cwd)?.projectId };
  const parsed = BoxRef.safeParse(ref);
  return parsed.success ? parsed.data : null;
}

export interface ImageWaitDeps {
  /** The registry is bound late (the VM stack exists before the automation module, but the binding is the module's). */
  readonly launches: () => Pick<LaunchRegistry, "activeFor"> | undefined;
  readonly boxOf: (row: TaskRow) => BoxRef | null;
}

/**
 * Does the task's box build its image now? A start made then would wait out the image step inside the outbox's 90 s deadline
 * and be retried five times: the task is put off instead, and no session is created. `position` is the builds ahead of it.
 */
export function createImageWait(deps: ImageWaitDeps) {
  return function imageBuild(row: TaskRow): { readonly position?: number } | null {
    const registry = deps.launches();
    const box = registry === undefined ? null : deps.boxOf(row);
    const launch = box === null ? null : (registry?.activeFor(box) ?? null);
    if (launch === null || launch.steps.find((step) => step.step === "image")?.state !== "running")
      return null;
    const position = launch.waiting?.reason === "image_build" ? launch.waiting.position : undefined;
    return position === undefined ? {} : { position };
  };
}
export type ImageWait = ReturnType<typeof createImageWait>;
