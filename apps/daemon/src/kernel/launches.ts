import {
  type BoxRef,
  type LaunchDetail,
  type LaunchStep,
  type LaunchStepState,
  type LaunchView,
  PapError,
  type Waiting,
} from "@pap/contracts";

/** What one caller reports of a launch it opened. */
export interface LaunchHandle {
  readonly id: string;
  /** `detail` is the last sign of life of a running step, already redacted. */
  step(step: LaunchStep, state: LaunchStepState, detail?: LaunchDetail): void;
  /** What the launch waits for now; null when it waits for nothing. */
  wait(waiting: Waiting | null): void;
  /** Whether the person stopped this launch (`LaunchRegistry.stop`): the start then rejects `stopped`, not `worker_failed`. */
  stopped(): boolean;
  /** The launch is over. Calls after it do nothing. `code` is the error of a failure. */
  end(ok: boolean, code?: string): void;
}

/**
 * The live launches of boxes (spec launch progress): a kernel port like `BoxControl`, because the agent-vm, sessions, automation
 * and projects modules all report to it. A box has one live launch: a second `open` on that box joins it, and the launch ends
 * with its last handle.
 */
export interface LaunchRegistry {
  open(input: { readonly box: BoxRef; readonly owner: string; readonly for: string }): LaunchHandle;
  /** The live launch of the box, or null. */
  activeFor(box: BoxRef): LaunchView | null;
  /** A handle on the box's live launch, to report steps from another place, or null. It does not count as an `open`: its `end` does nothing. */
  handleFor(box: BoxRef): LaunchHandle | null;
  /**
   * Ends the live launch `id` as `ok: false, code: "stopped"` and returns what it was, or null when no such launch lives. Later
   * ends by its handles (the start rejecting after the box stops) are ignored.
   */
  stop(id: string): LaunchView | null;
  /** The owner's live launches. */
  live(owner: string): readonly LaunchView[];
  /** Told when a launch opens, changes state or ends; throwing listeners are skipped. */
  onChange(listener: (box: BoxRef) => void): () => void;
  /** Daemon shutdown: clears every timer and ends the live launches (`ok: false`, `closed`). */
  close(): void;
  /** Owners with an open `launches` subscription now. */
  subscribedOwners(): readonly string[];
}

/** What a start reports a launch's steps through. */
export type LaunchSteps = Pick<LaunchHandle, "step">;

/** The code a failed launch ends with: a `PapError`'s own, `internal` for anything else. */
export const launchCodeOf = (error: unknown): string => (error instanceof PapError ? error.code : "internal");

/** What an image resolution tells the launch it serves (`resolve` takes it optionally). */
export interface ImageObserver {
  /** The image was already built, or its VM already runs: nothing is built. */
  skipped(): void;
  /** Waiting behind another image build (`position` in line), or null once it is this one's turn. */
  waiting(position: number | null): void;
  /** The tag being built now. */
  building(tag: string): void;
  /** The last line BuildKit printed (already redacted) and when; told about every 2 s while a build runs. */
  line?(line: string, at: number): void;
}

/**
 * Marks `step` around `work`: running, then done, or failed when it throws. `work` may call `skip()` to end it `skipped`
 * instead. A launch that is absent (a path nobody follows) just runs.
 */
export async function stepAround<T>(
  handle: Pick<LaunchHandle, "step"> | null | undefined,
  step: LaunchStep,
  work: (skip: () => void) => Promise<T>,
): Promise<T> {
  if (!handle) return work(() => {});
  let final: LaunchStepState = "done";
  handle.step(step, "running");
  try {
    const out = await work(() => void (final = "skipped"));
    handle.step(step, final);
    return out;
  } catch (error) {
    handle.step(step, "failed");
    throw error;
  }
}

/** The `image` step around an image resolution: the observer sets `skipped`, the queue wait and the tag being built. */
export function imageStep<T>(
  handle: Pick<LaunchHandle, "step" | "wait"> | null | undefined,
  work: (observer: ImageObserver | undefined) => Promise<T>,
  onBuilding?: (tag: string) => void,
): Promise<T> {
  if (!handle) return work(undefined);
  return stepAround(handle, "image", async (skip) => {
    let waited = false;
    const observer: ImageObserver = {
      skipped: skip,
      waiting(position) {
        if (position === null && !waited) return;
        waited = position !== null;
        handle.wait(position === null ? null : { reason: "image_build", position });
      },
      building: (tag) => onBuilding?.(tag),
      line: (line, at) => handle.step("image", "running", { line, at }),
    };
    try {
      return await work(observer);
    } finally {
      if (waited) handle.wait(null);
    }
  });
}
