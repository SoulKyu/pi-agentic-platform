import type { Clock, TimerHandle } from "../clock.ts";
import type { HelperPoolStatus } from "./pool.ts";

export const HELPER_FEED_EVERY_MS = 1000;

/**
 * Passes the pool's counts on at most once a second and only when they differ from the last ones sent. A change inside the
 * second is held and sent when the second ends, with the counts of that moment.
 */
export function createHelperFeed(options: {
  readonly clock: Pick<Clock, "now" | "setTimeout" | "clearTimeout">;
  readonly send: (status: HelperPoolStatus) => void;
}): { push(status: HelperPoolStatus): void; stop(): void } {
  const { clock } = options;
  let sent: HelperPoolStatus | null = null;
  let latest: HelperPoolStatus | null = null;
  let sentAt = Number.NEGATIVE_INFINITY;
  let timer: TimerHandle | undefined;
  const same = (a: HelperPoolStatus, b: HelperPoolStatus): boolean =>
    a.active === b.active && a.max === b.max && a.waiting === b.waiting;
  const flush = (): void => {
    timer = undefined;
    if (latest === null || (sent !== null && same(latest, sent))) return;
    sent = latest;
    sentAt = clock.now();
    options.send(latest);
  };
  return {
    push(status) {
      latest = status;
      if (timer !== undefined) return;
      const wait = sentAt + HELPER_FEED_EVERY_MS - clock.now();
      if (wait <= 0) flush();
      else timer = clock.setTimeout(flush, wait);
    },
    stop() {
      if (timer !== undefined) clock.clearTimeout(timer);
      timer = undefined;
    },
  };
}
