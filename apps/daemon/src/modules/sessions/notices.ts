import { type Notice, SERVER_CODES, type SessionStreamEvent, UI_LIMITS } from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";

export interface NoticeRing {
  add(notice: Notice): void;
  list(): Notice[];
}

/** The last `max` notices of every source, texts cut: what a subscriber without a cursor gets in its snapshot (M2R85). */
export function createNoticeRing(max: number = UI_LIMITS.notices): NoticeRing {
  const notices: Notice[] = [];
  return {
    add(notice) {
      const text = notice.text.slice(0, UI_LIMITS.noticeText);
      notices.push({
        level: notice.level,
        text,
        ...(notice.source ? { source: notice.source } : {}),
        ...(notice.code ? { code: notice.code } : {}),
        ...(notice.params ? { params: notice.params } : {}),
      });
      if (notices.length > max) notices.splice(0, notices.length - max);
    },
    list: () => [...notices],
  };
}

export interface NoticeLimiterDeps {
  readonly clock: Clock;
  publish(event: SessionStreamEvent): void;
  readonly max?: number;
  readonly windowMs?: number;
}

export interface NoticeLimiter {
  add(notice: Notice): void;
  /** Ends the window, says what it held back (once), and leaves no timer. */
  stop(): void;
}

const summary = (count: number): Notice =>
  count === 1
    ? {
        level: "warning",
        text: "1 more notice from extensions was not shown.",
        code: SERVER_CODES.noticesHeldOne,
      }
    : {
        level: "warning",
        text: `${count} more notices from extensions were not shown.`,
        code: SERVER_CODES.noticesHeldMany,
        params: { count: String(count) },
      };

/**
 * M2R84. At most `max` notices per window; the rest are counted, and one pap notice with the count ends the window. The
 * summary goes out directly, never through the limit it reports, so it cannot be limited away.
 */
export function createNoticeLimiter(deps: NoticeLimiterDeps): NoticeLimiter {
  const max = deps.max ?? 10;
  const windowMs = deps.windowMs ?? 10_000;
  let timer: TimerHandle | null = null;
  let shown = 0;
  let held = 0;
  return {
    add(notice) {
      if (timer === null) {
        shown = 0;
        held = 0;
        timer = deps.clock.setTimeout(() => {
          timer = null;
          const count = held;
          held = 0;
          shown = 0;
          if (count > 0) deps.publish({ kind: "notice", ...summary(count) });
        }, windowMs);
      }
      if (shown >= max) {
        held++;
        return;
      }
      shown++;
      deps.publish({ kind: "notice", ...notice });
    },
    stop() {
      if (timer !== null) deps.clock.clearTimeout(timer);
      timer = null;
      const count = held;
      shown = 0;
      held = 0;
      if (count > 0) deps.publish({ kind: "notice", ...summary(count) });
    },
  };
}
