import {
  LAUNCH_STEP_LIMITS_MS,
  type LaunchStep,
  type LaunchStepView,
  type LaunchView,
  type Waiting,
} from "@pap/contracts";
import type { MessageKey, Translate } from "../../i18n/index.ts";
import { formatLaunchTime } from "../../stores/launch-store.ts";

/** A step is "slower than usual" past this many times its median. */
export const SLOW_FACTOR = 2;
/** The ask appears at this share of a step's limit. */
export const ASK_SHARE = 0.75;
/** An image build whose last line is older than this asks, whatever its share of the limit. */
export const QUIET_IMAGE_MS = 120_000;

/** How long a step has run: to its end when it is over, to `now` while it runs, 0 before it starts. */
export function elapsedMs(step: LaunchStepView, now: number): number {
  if (step.startedAt === null) return 0;
  return Math.max(0, (step.endedAt ?? now) - step.startedAt);
}

export const isRunning = (step: LaunchStepView): boolean => step.state === "running";

export function isSlow(step: LaunchStepView, now: number): boolean {
  return isRunning(step) && step.usualMs !== null && elapsedMs(step, now) > SLOW_FACTOR * step.usualMs;
}

export interface Ask {
  readonly step: LaunchStep;
  /** `quiet`: no build line for `ms` (an image only). `long`: the step has run `ms`, 75 % of its limit or more (R14). */
  readonly kind: "quiet" | "long";
  readonly ms: number;
  readonly limitMs: number;
  /** R8: only an image step has a log to show; the other steps offer Stop alone. */
  readonly log: boolean;
  /** R13: Stop is offered iff the daemon marked the launch `stoppable`. */
  readonly stop: boolean;
}

/**
 * The ask of the running step, or none (R14): for an image when its last line (or its start, when none came) is older than
 * 120 s, else at 75 % of the limit. Never while the launch waits in the build queue: the step has not started building.
 */
export function askOf(launch: Pick<LaunchView, "steps" | "waiting" | "stoppable">, now: number): Ask | null {
  const live = launch.steps.find(isRunning);
  if (live === undefined || live.startedAt === null) return null;
  if (launch.waiting?.reason === "image_build") return null;
  const limitMs = LAUNCH_STEP_LIMITS_MS[live.step];
  const elapsed = elapsedMs(live, now);
  const image = live.step === "image";
  const quietMs = Math.max(0, now - (live.detail?.at ?? live.startedAt));
  const stop = launch.stoppable === true;
  if (image && quietMs > QUIET_IMAGE_MS && elapsed < limitMs * ASK_SHARE)
    return { step: live.step, kind: "quiet", ms: quietMs, limitMs, log: true, stop };
  if (elapsed >= limitMs * ASK_SHARE)
    return { step: live.step, kind: "long", ms: elapsed, limitMs, log: image, stop };
  return null;
}

/** The catalog key of a step's name; an agent's image is the agent image. */
export function stepKey(step: LaunchStep, boxKind: "project" | "agent"): MessageKey {
  return step === "image" && boxKind === "agent" ? "launch.step.imageAgent" : `launch.step.${step}`;
}

/** What a step row says on the right: nothing before it starts, "already built" when skipped, else its time (and the usual). */
export function stepTime(step: LaunchStepView, now: number, t: Translate): string | null {
  if (step.state === "skipped") return t("launch.time.skipped");
  if (step.state === "pending" || step.startedAt === null) return null;
  const elapsed = formatLaunchTime(elapsedMs(step, now));
  if (step.usualMs === null || step.state === "failed") return elapsed;
  return t("launch.time.usual", { elapsed, usual: formatLaunchTime(step.usualMs) });
}

const GB = 1024;
const gigabytes = (megabytes: number): string => (megabytes / GB).toFixed(1);

/** The freeing action of a reason, when it has one: a button (`kind: "action"`) or a hint. */
export interface WaitingWords {
  readonly text: string;
  readonly action: { readonly kind: "button" | "hint"; readonly label: string } | null;
}

/** The words of a wait. A value the daemon did not send leaves its part out. */
export function waitingWords(waiting: Waiting, now: number, t: Translate): WaitingWords {
  const { reason } = waiting;
  let text: string;
  let action: WaitingWords["action"] = null;
  switch (reason) {
    case "session_slots":
      text =
        waiting.used !== undefined && waiting.max !== undefined
          ? t("launch.wait.session_slots", { used: waiting.used, max: waiting.max })
          : t("launch.wait.session_slots.short");
      action = { kind: "button", label: t("launch.wait.session_slots.action") };
      break;
    case "box_memory":
      text =
        waiting.used !== undefined && waiting.max !== undefined
          ? t("launch.wait.box_memory", {
              used: gigabytes(waiting.used),
              max: `${gigabytes(waiting.max)} GB`,
            })
          : t("launch.wait.box_memory.short");
      action = { kind: "hint", label: t("launch.wait.box_memory.action") };
      break;
    case "image_build":
      text =
        waiting.position === undefined
          ? t("launch.wait.image_build.short")
          : t("launch.wait.image_build", { position: waiting.position });
      break;
    case "pi_reads":
      text =
        waiting.position === undefined
          ? t("launch.wait.pi_reads.short")
          : t("launch.wait.pi_reads", { waiting: waiting.position });
      break;
    case "paused":
      text = t("launch.wait.paused");
      action = { kind: "button", label: t("launch.wait.paused.action") };
      break;
    case "budget":
      text = t("launch.wait.budget");
      break;
    case "relay":
      text = t("launch.wait.relay");
      break;
    case "thread_busy":
      text = t("launch.wait.thread_busy");
      break;
  }
  if (waiting.nextTryAt !== undefined) {
    const seconds = formatLaunchTime(Math.max(0, waiting.nextTryAt - now));
    text = `${text} · ${t("launch.wait.next", { seconds })}`;
  }
  return { text, action };
}
