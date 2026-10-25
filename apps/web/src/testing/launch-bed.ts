import type { LaunchStep, LaunchStepView, LaunchView } from "@pap/contracts";
import { LAUNCH_STEPS, LAUNCH_STEP_LIMITS_MS } from "@pap/contracts";

export const PROJECT_BOX = "0b1c2d3e-4f50-4162-8394-a5b6c7d8e9f0";

/** One step of a launch; a started step carries its deadline, like the daemon's. */
export function stepOf(step: LaunchStep, patch: Partial<LaunchStepView> = {}): LaunchStepView {
  const startedAt = patch.startedAt ?? null;
  return {
    step,
    state: "pending",
    startedAt,
    endedAt: null,
    usualMs: null,
    deadlineAt: startedAt === null ? null : startedAt + LAUNCH_STEP_LIMITS_MS[step],
    detail: null,
    ...patch,
  };
}

/** A project box launch whose steps up to `running` are done, `running` is live, the rest pending. */
export function launchAt(
  running: LaunchStep,
  startedAt: number,
  patch: Partial<LaunchView> = {},
  step: Partial<LaunchStepView> = {},
): LaunchView {
  const at = LAUNCH_STEPS.indexOf(running);
  return {
    id: "l1",
    box: { kind: "project", id: PROJECT_BOX },
    for: "start",
    startedAt: startedAt - 1000 * at,
    steps: LAUNCH_STEPS.slice(0, 5).map((name, index) =>
      index < at
        ? stepOf(name, {
            state: "done",
            startedAt: startedAt - 1000 * (at - index),
            endedAt: startedAt - 1000 * (at - index - 1),
          })
        : index === at
          ? stepOf(name, { state: "running", startedAt, ...step })
          : stepOf(name),
    ),
    ...patch,
  };
}
