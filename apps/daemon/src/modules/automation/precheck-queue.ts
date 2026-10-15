export type PrecheckOrigin = "scheduler" | "manual";
export type PrecheckSlot =
  { readonly ok: true; release(): void } | { readonly ok: false; readonly reason: "busy" | "aborted" };

/** Running at once in the daemon (M10R71). */
export const PRECHECKS_RUNNING_MAX = 2;
/** Manual and token prechecks waiting past this are refused; scheduler ones are bounded by their trigger count. */
export const MANUAL_WAITING_MAX = 8;

interface Waiter {
  readonly triggerId: string;
  readonly origin: PrecheckOrigin;
  readonly grant: (slot: PrecheckSlot) => void;
  readonly signal: AbortSignal | undefined;
  onAbort?: () => void;
}

/**
 * The daemon's precheck slots (M10R71): one precheck per trigger (running or waiting), at most `limit` running, the rest
 * in a first-in first-out line. Refused, never evicted.
 */
export function createPrecheckQueue(options: { limit?: number; manualWaitMax?: number } = {}) {
  const limit = options.limit ?? PRECHECKS_RUNNING_MAX;
  const manualWaitMax = options.manualWaitMax ?? MANUAL_WAITING_MAX;
  const running = new Set<string>();
  const waiting: Waiter[] = [];

  function start(triggerId: string): PrecheckSlot {
    running.add(triggerId);
    let released = false;
    return {
      ok: true,
      release() {
        if (released) return;
        released = true;
        running.delete(triggerId);
        const next = waiting.shift();
        if (!next) return;
        if (next.onAbort) next.signal?.removeEventListener("abort", next.onAbort);
        next.grant(start(next.triggerId));
      },
    };
  }

  const holds = (triggerId: string): boolean =>
    running.has(triggerId) || waiting.some((waiter) => waiter.triggerId === triggerId);

  return {
    acquire(triggerId: string, origin: PrecheckOrigin, signal?: AbortSignal): Promise<PrecheckSlot> {
      if (signal?.aborted) return Promise.resolve({ ok: false, reason: "aborted" });
      if (holds(triggerId)) return Promise.resolve({ ok: false, reason: "busy" });
      if (running.size < limit) return Promise.resolve(start(triggerId));
      if (
        origin === "manual" &&
        waiting.filter((waiter) => waiter.origin === "manual").length >= manualWaitMax
      )
        return Promise.resolve({ ok: false, reason: "busy" });
      return new Promise((resolve) => {
        const waiter: Waiter = { triggerId, origin, grant: resolve, signal };
        waiter.onAbort = () => {
          const at = waiting.indexOf(waiter);
          if (at >= 0) waiting.splice(at, 1);
          resolve({ ok: false, reason: "aborted" });
        };
        signal?.addEventListener("abort", waiter.onAbort, { once: true });
        waiting.push(waiter);
      });
    },
  };
}
export type PrecheckQueue = ReturnType<typeof createPrecheckQueue>;
