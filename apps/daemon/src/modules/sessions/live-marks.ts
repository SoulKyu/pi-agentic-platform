import type { PiEvent } from "@pap/contracts";

/**
 * R32, live: a `message_end` of a user message a VM worker made up (an extension's, or a forged one) is sent on with
 * `unverified: true`, the mark a finished run's row gets from the mirror. The mark is the daemon's alone: whatever
 * `unverified` the worker's own event carried is dropped first, and only a handle that knows what pap sent (a VM
 * worker's) can set it. Any other event goes on untouched.
 */
export function markUnsent(
  event: PiEvent,
  handle: { unsentUserMessage?(message: unknown): boolean },
): PiEvent {
  if (event.type !== "message_end") return event;
  const rest = { ...event };
  delete rest.unverified;
  const message = event.message as { role?: unknown } | null | undefined;
  return message?.role === "user" && handle.unsentUserMessage?.(message) === true
    ? { ...rest, unverified: true }
    : (rest as PiEvent);
}
