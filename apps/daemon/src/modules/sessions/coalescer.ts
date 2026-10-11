import type { PiEvent } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export const DELTA_FLUSH_MS = 50;
const MERGEABLE = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
/** Text pending past this goes out at once: one window of a fast model never holds megabytes. */
const MAX_PENDING_CHARS = 256 * 1024;
/** Distinct blocks and tools pending past this go out at once: a worker inventing tool ids cannot grow the map. */
export const MAX_PENDING_ITEMS = 256;

interface PendingDelta {
  readonly kind: "delta";
  readonly type: string;
  readonly contentIndex: number;
  delta: string;
  usage: unknown;
}
interface PendingTool {
  readonly kind: "tool";
  readonly event: PiEvent;
}

function deltaOf(event: PiEvent): { type: string; contentIndex: number; delta: string } | null {
  if (event.type !== "message_update") return null;
  const update = event.assistantMessageEvent as
    { type?: unknown; contentIndex?: unknown; delta?: unknown } | undefined;
  if (!update || typeof update.type !== "string" || !MERGEABLE.has(update.type)) return null;
  if (typeof update.contentIndex !== "number" || typeof update.delta !== "string") return null;
  return { type: update.type, contentIndex: update.contentIndex, delta: update.delta };
}

export interface Coalescer {
  push(event: PiEvent): void;
  flush(): void;
  dispose(): void;
}

/**
 * Text, thinking and tool-call deltas are merged per content block and sent at most every 50 ms (spec C §4.3). A
 * tool's progress keeps only its latest update, and a pending one is dropped when the tool ends (or the tool would
 * read as running again). Any other event first sends what is pending, in arrival order: nothing overtakes text.
 */
export function createCoalescer(deps: {
  clock: Clock;
  emit(event: PiEvent): void;
  flushMs?: number;
}): Coalescer {
  const pending = new Map<string, PendingDelta | PendingTool>();
  let pendingChars = 0;
  let timer: TimerHandle | null = null;
  const disarm = (): void => {
    if (timer) deps.clock.clearTimeout(timer);
    timer = null;
  };
  const flush = (): void => {
    disarm();
    const items = [...pending.values()];
    pending.clear();
    pendingChars = 0;
    for (const item of items) {
      deps.emit(
        item.kind === "tool"
          ? item.event
          : {
              type: "message_update",
              ...(item.usage === undefined ? {} : { usage: item.usage }),
              assistantMessageEvent: { type: item.type, contentIndex: item.contentIndex, delta: item.delta },
            },
      );
    }
  };
  const arm = (): void => {
    timer ??= deps.clock.setTimeout(flush, deps.flushMs ?? DELTA_FLUSH_MS);
  };
  return {
    push(event) {
      const delta = deltaOf(event);
      if (delta) {
        // What is pending goes first, so a merged frame is never bigger than the cap or than one delta.
        if (pendingChars + delta.delta.length > MAX_PENDING_CHARS) flush();
        const key = `${delta.type}:${delta.contentIndex}`;
        const current = pending.get(key);
        if (current?.kind === "delta") {
          current.delta += delta.delta;
          current.usage = event.usage ?? current.usage;
        } else {
          pending.set(key, { kind: "delta", ...delta, usage: event.usage });
        }
        pendingChars += delta.delta.length;
        if (pendingChars > MAX_PENDING_CHARS || pending.size > MAX_PENDING_ITEMS) flush();
        else arm();
        return;
      }
      if (
        typeof event.toolCallId === "string" &&
        (event.type === "tool_execution_update" || event.type === "tool_execution_end")
      ) {
        pending.delete(`tool:${event.toolCallId}`);
        if (event.type === "tool_execution_update") {
          pending.set(`tool:${event.toolCallId}`, { kind: "tool", event });
          if (pending.size > MAX_PENDING_ITEMS) flush();
          else arm();
          return;
        }
      }
      flush();
      deps.emit(event);
    },
    flush,
    dispose() {
      disarm();
      pending.clear();
      pendingChars = 0;
    },
  };
}
