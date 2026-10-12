import { EMPTY_QUEUE, PapError, type QueueView, UI_LIMITS } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { WorkerHandle } from "../../kernel/supervisor/worker.ts";
import { PAGE_BYTES, sizeOf } from "./snapshot.ts";
import { clip } from "./worker-text.ts";

export const MAX_QUEUED_MESSAGES = 128;
export const MAX_QUEUED_BYTES = 32 * 1024 * 1024;
/**
 * The most JSON bytes the queue's previews take in a `queue` event and in a snapshot. Small on purpose: the snapshot
 * also carries the approvals a run waits on and its rows, and the user's texts come back whole from `clearQueue`.
 */
export const QUEUE_PREVIEW_BYTES = 64 * 1024;
/** The contract's longest prompt (`sessions.prompt`); a queued text over it is not one the client could have sent. */
const MAX_TEXT_CHARS = 200_000;

export interface FittedTexts {
  steering: string[];
  followUp: string[];
  truncated: boolean;
}

/**
 * Queued texts under `budget` JSON bytes (quotes, backslashes and control characters grow when escaped; M2-RT-28):
 * at most `UI_LIMITS.queueEntries` per list, text only, none over a prompt's length, the first that fit kept in their
 * order, as a contiguous prefix: the first that does not fit ends the lists, so the UI can show "N more" from `count`.
 * `truncated` says when anything was left out.
 */
export function fitTexts(
  steering: readonly unknown[],
  followUp: readonly unknown[],
  budget: number,
): FittedTexts {
  let left = budget;
  let truncated = false;
  let full = false;
  const take = (texts: readonly unknown[]): string[] => {
    if (texts.length > UI_LIMITS.queueEntries) truncated = true;
    const kept: string[] = [];
    for (const text of texts.slice(0, UI_LIMITS.queueEntries)) {
      const size = typeof text === "string" ? Buffer.byteLength(JSON.stringify(text)) + 1 : Infinity;
      if (full || typeof text !== "string" || text.length > MAX_TEXT_CHARS || size > left) {
        full = true;
        truncated = true;
        break;
      }
      left -= size;
      kept.push(text);
    }
    return kept;
  };
  const fitted = { steering: take(steering), followUp: take(followUp) };
  return { ...fitted, truncated };
}

/** Whether `clear_queue` answered with the two lists the contract expects. */
export const isClearedAnswer = (data: unknown): boolean =>
  typeof data === "object" &&
  data !== null &&
  Array.isArray((data as { steering?: unknown }).steering) &&
  Array.isArray((data as { followUp?: unknown }).followUp);

/** What `clear_queue` answered, as the contract carries it. Anything but two lists of texts reads as empty and cut. */
export function readCleared(data: unknown): FittedTexts {
  const answer = (typeof data === "object" && data !== null ? data : {}) as {
    steering?: unknown;
    followUp?: unknown;
    truncated?: unknown;
  };
  if (!Array.isArray(answer.steering) || !Array.isArray(answer.followUp)) {
    return { steering: [], followUp: [], truncated: true };
  }
  // The envelope (the field names and the flag) takes a few dozen bytes of the frame.
  const fitted = fitTexts(
    answer.steering,
    answer.followUp,
    PAGE_BYTES - sizeOf({ steering: [], followUp: [], truncated: true }),
  );
  return { ...fitted, truncated: fitted.truncated || answer.truncated === true };
}

/** Asks the worker to empty Pi's queue and fits the texts it returns; `worker_failed` when it refuses. */
export async function clearWorkerQueue(handle: WorkerHandle, logger: Logger): Promise<FittedTexts> {
  const response = await handle.request({ type: "clear_queue" });
  if (!response.success) {
    logger.info("clear_queue_failed", { error: clip(response.error ?? "") });
    throw new PapError("worker_failed");
  }
  if (!isClearedAnswer(response.data)) {
    logger.warn("clear_queue_unreadable", { detail: clip(JSON.stringify(response.data) ?? "") });
  }
  return readCleared(response.data);
}

export interface QueueGuard {
  /** Counts a prompt on its way to Pi; the returned function uncounts it once Pi has answered. */
  admit(text: string): () => void;
  onQueueUpdate(update: {
    steering: readonly string[];
    followUp: readonly string[];
    count: number;
    bytes: number;
  }): QueueView;
  view(): QueueView;
  reset(): void;
}

const total = (value: unknown): number => Math.max(0, Math.trunc(Number(value)) || 0);

/**
 * Pi's steering and follow-up queue, capped at 128 messages and 32 MiB (spec C 2.4). What Pi holds comes from its
 * `queue_update` events; what is on its way is counted until Pi answers the prompt, so a burst of prompts cannot slip
 * past the cap between two updates. Counting a prompt twice for a moment (in flight and already in Pi's next update)
 * errs on the side of refusing (M2R57). The previews are cut to the contract and fitted in JSON bytes, so one event
 * stays inside the frame whatever the texts hold.
 */
export function createQueueGuard(): QueueGuard {
  let held = EMPTY_QUEUE;
  let inFlight = 0;
  let inFlightBytes = 0;
  // A release that comes after `reset` belongs to a count that is gone: it must not uncount what was admitted since.
  let epoch = 0;
  return {
    admit(text) {
      const size = Buffer.byteLength(text);
      if (
        held.count + inFlight + 1 > MAX_QUEUED_MESSAGES ||
        held.bytes + inFlightBytes + size > MAX_QUEUED_BYTES
      ) {
        throw new PapError("queue_full");
      }
      inFlight++;
      inFlightBytes += size;
      let released = false;
      const admittedIn = epoch;
      return () => {
        if (released || admittedIn !== epoch) return;
        released = true;
        inFlight--;
        inFlightBytes -= size;
      };
    },
    onQueueUpdate(update) {
      const preview = (texts: unknown): unknown[] =>
        (Array.isArray(texts) ? texts : [])
          .filter((text): text is string => typeof text === "string")
          .map((text) => text.slice(0, UI_LIMITS.queuePreviewChars));
      const { steering, followUp } = fitTexts(
        preview(update.steering),
        preview(update.followUp),
        QUEUE_PREVIEW_BYTES - sizeOf(EMPTY_QUEUE),
      );
      held = { steering, followUp, count: total(update.count), bytes: total(update.bytes) };
      return held;
    },
    view: () => held,
    reset() {
      epoch++;
      held = EMPTY_QUEUE;
      inFlight = 0;
      inFlightBytes = 0;
    },
  };
}
