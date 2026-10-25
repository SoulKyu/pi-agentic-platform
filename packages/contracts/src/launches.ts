import { z } from "zod";
import { BoxRef } from "./box-ref.ts";

/** The steps of a launch, in order. The worker step exists only when a session or task waits for a Pi worker. */
export const LAUNCH_STEPS = ["checks", "image", "disk", "vm", "guest", "worker"] as const;
export const LaunchStep = z.enum(LAUNCH_STEPS);
export type LaunchStep = z.infer<typeof LaunchStep>;

export const LaunchStepState = z.enum(["pending", "running", "done", "skipped", "failed"]);
export type LaunchStepState = z.infer<typeof LaunchStepState>;

/** The hard limit of each step, in ms: what pap gives up at. The ask appears at 75 % of it. */
export const LAUNCH_STEP_LIMITS_MS: { readonly [S in LaunchStep]: number } = Object.freeze({
  checks: 30_000,
  image: 30 * 60_000,
  disk: 10 * 60_000,
  vm: 60_000,
  guest: 60_000,
  worker: 30_000,
});

export const LAUNCH_LIMITS = Object.freeze({
  /** Longest build line the daemon sends (the vmd tail clips to the same). */
  lineChars: 512,
  /** The tail pap-vmd keeps per image tag, and the most `launches.log` answers. */
  logLines: 200,
  /** Live launches in one snapshot. */
  launches: 64,
});

const Ms = z.number().int().nonnegative();

/** The last sign of life of a step (an image build prints one): the line is redacted by the daemon. */
export const LaunchDetail = z.object({ line: z.string().max(LAUNCH_LIMITS.lineChars), at: Ms }).strict();
export type LaunchDetail = z.infer<typeof LaunchDetail>;

export const LaunchStepView = z
  .object({
    step: LaunchStep,
    state: LaunchStepState,
    startedAt: Ms.nullable(),
    endedAt: Ms.nullable(),
    /** Median of the box's last 20 runs of this step; null below 3 samples. */
    usualMs: Ms.nullable(),
    /** startedAt + the step's limit; null until it starts. */
    deadlineAt: Ms.nullable(),
    detail: LaunchDetail.nullable(),
    /** The error code of a failed step. */
    code: z.string().min(1).max(64).optional(),
  })
  .strict();
export type LaunchStepView = z.infer<typeof LaunchStepView>;

export const WAITING_REASONS = [
  "session_slots",
  "box_memory",
  "image_build",
  "pi_reads",
  "budget",
  "paused",
  "relay",
  "thread_busy",
] as const;
export const WaitingReason = z.enum(WAITING_REASONS);
export type WaitingReason = z.infer<typeof WaitingReason>;

/** What a launch or a task waits for. `pi_reads` carries the reads ahead in `position`. */
export const Waiting = z
  .object({
    reason: WaitingReason,
    used: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
    position: z.number().int().nonnegative().optional(),
    nextTryAt: Ms.optional(),
  })
  .strict();
export type Waiting = z.infer<typeof Waiting>;

/** One live launch of a box, as its owner sees it. `for`: what asked for it (a session id, a task id, `start`). */
export const LaunchView = z
  .object({
    id: z.string().min(1).max(128),
    box: BoxRef,
    for: z.string().min(1).max(128),
    startedAt: Ms,
    steps: z.array(LaunchStepView).max(LAUNCH_STEPS.length),
    waiting: Waiting.optional(),
    /** Set by the daemon at each publish: true when Stop is allowed now (R13). Absent: it is not. */
    stoppable: z.boolean().optional(),
  })
  .strict();
export type LaunchView = z.infer<typeof LaunchView>;

/** The last event of a launch: it ended, well or not. `code` is the error the failing call returned. */
export const LaunchEnd = z
  .object({
    id: z.string().min(1).max(128),
    done: z.literal(true),
    ok: z.boolean(),
    code: z.string().min(1).max(64).optional(),
  })
  .strict();
export type LaunchEnd = z.infer<typeof LaunchEnd>;

/** Install-wide Pi helper counts: no ids, safe for members. */
export const HelperStatus = z
  .object({
    active: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
    waiting: z.number().int().nonnegative(),
  })
  .strict();
export type HelperStatus = z.infer<typeof HelperStatus>;

export const LaunchesStreamEvent = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("snapshot"),
      launches: z.array(LaunchView).max(LAUNCH_LIMITS.launches),
      helpers: HelperStatus,
    })
    .strict(),
  z.object({ kind: z.literal("launch"), launch: LaunchView }).strict(),
  z.object({ kind: z.literal("end"), ...LaunchEnd.shape }).strict(),
  z.object({ kind: z.literal("helpers"), helpers: HelperStatus }).strict(),
]);
export type LaunchesStreamEvent = z.infer<typeof LaunchesStreamEvent>;
