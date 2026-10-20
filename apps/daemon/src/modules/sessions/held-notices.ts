import type { Logger } from "../../kernel/logger.ts";

/** Sessions with notices waiting, and notices kept per session; the oldest session / the newest notice past these is dropped and counted. */
export const MAX_HELD_SESSIONS = 64;
export const MAX_HELD_PER_SESSION = 4;

/**
 * Notices for a session that is not live yet (a mirror recovered at its open, a replacement seen in the same tick as `ready`):
 * they wait, a few per session, and are posted when the session's start ends. A notice that is finally dropped writes a line.
 */
export function createHeldNotices(deps: {
  /** Posts to the live session; false when there is none. */
  post(sessionId: string, text: string): boolean;
  readonly logger: Pick<Logger, "warn">;
}) {
  const held = new Map<string, { texts: string[]; dropped: number }>();
  const lost = (sessionId: string, count: number): void =>
    deps.logger.warn("mirror_notice_dropped", { sessionId, dropped: count });
  return {
    hold(sessionId: string, text: string): void {
      let entry = held.get(sessionId);
      if (entry === undefined) {
        if (held.size >= MAX_HELD_SESSIONS) {
          const [oldest] = held.keys();
          const gone = oldest === undefined ? undefined : held.get(oldest);
          if (oldest !== undefined && gone !== undefined) {
            held.delete(oldest);
            lost(oldest, gone.texts.length + gone.dropped);
          }
        }
        entry = { texts: [], dropped: 0 };
        held.set(sessionId, entry);
      }
      if (entry.texts.length >= MAX_HELD_PER_SESSION) {
        entry.dropped++;
        lost(sessionId, 1);
      } else entry.texts.push(text);
    },
    flush(sessionId: string): void {
      const entry = held.get(sessionId);
      if (entry === undefined) return;
      for (const [position, text] of entry.texts.entries()) {
        if (deps.post(sessionId, text)) continue;
        // The start failed: the session is not live. What is left stays for its next start.
        entry.texts.splice(0, position);
        return;
      }
      held.delete(sessionId);
    },
  };
}
