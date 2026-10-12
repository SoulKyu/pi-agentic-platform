import type { Runtime } from "../../runtime/index.ts";
import { mergeRestored } from "../../stores/drafts.ts";

export type Behavior = "steer" | "followUp";
export interface Cleared {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}
const BEHAVIOR_KEY = "pap.sessions.streaming";

export function loadBehavior(storage: Storage | null): Behavior {
  try {
    return storage?.getItem(BEHAVIOR_KEY) === "followUp" ? "followUp" : "steer";
  } catch {
    return "steer";
  }
}

export function saveBehavior(storage: Storage | null, behavior: Behavior): void {
  try {
    storage?.setItem(BEHAVIOR_KEY, behavior);
  } catch {
    // The choice simply lasts this page; drafts already say once that storage refuses.
  }
}

/**
 * Pi ignores the streaming behaviour when it is idle (pinned in Task 12), so it is always sent. The text goes as typed:
 * only trailing whitespace is trimmed, so a pasted block keeps its first line's indentation (M2-RT-36).
 */
export function planSend(
  text: string,
  behavior: Behavior,
): { text: string; streamingBehavior: Behavior } | null {
  const typed = text.trimEnd();
  return typed.trim() ? { text: typed, streamingBehavior: behavior } : null;
}

export function restoreCleared(cleared: Cleared, current: string): string {
  return mergeRestored([...cleared.steering, ...cleared.followUp].join("\n\n"), current);
}

/**
 * Stop as the pi TUI's Esc: what waits in the queue comes back to the composer, and the run stops. Both calls leave
 * at once and reach the worker in order (the daemon sends `clear_queue` at once; `abort` asks `get_state` first): a
 * `clearQueue` that fails or times out must never keep the run going (M2-RT-09). Only the abort's failure is thrown;
 * `onCleared` receives what was cleared before that, so the texts are not lost when the abort fails.
 */
export async function stopSession(
  runtime: Runtime,
  sessionId: string,
  onCleared?: (cleared: Cleared) => void,
): Promise<{ steering: string[]; followUp: string[] }> {
  const [cleared, aborted] = await Promise.allSettled([
    runtime.rpc.call("sessions.clearQueue", { sessionId }),
    runtime.rpc.call("sessions.abort", { sessionId }),
  ]);
  const texts =
    cleared.status === "fulfilled"
      ? { steering: cleared.value.steering, followUp: cleared.value.followUp }
      : { steering: [], followUp: [] };
  if (cleared.status === "fulfilled") onCleared?.(texts);
  if (aborted.status === "rejected") throw aborted.reason;
  return texts;
}
