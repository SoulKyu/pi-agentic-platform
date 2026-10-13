import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { StreamHub } from "../../kernel/ws/stream-hub.ts";
import type { LiveSession } from "./live-session.ts";
import { fileSizeOrZero, isPiSessionFile } from "./pi-files.ts";
import type { PreReadyBuffer } from "./pre-ready-buffer.ts";
import type { SessionRow, SessionsStore } from "./store.ts";

export interface StoreSyncDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: Pick<StreamHub, "publish">;
  readonly agentDir: string;
  /** A worker's policy record (an audit entry, as unknown): it goes to the audit module, not to `session_events`. */
  onPolicyRecord(row: SessionRow, raw: unknown): void;
  /** The worker reports its taint, with the taint epoch it holds (M5R60): the daemon stores it, not `session_events`. */
  onTaint(row: SessionRow, epoch: number): void;
}

/** What the service writes to the store as a worker goes about its work: the file Pi wrote, events, the name. */
export function createStoreSync(deps: StoreSyncDeps) {
  // Pi writes a session's file with the first user message, not at creation (S1). Once it exists, the session
  // remembers it: that is what a restart reopens. Returns true when there is nothing left to wait for.
  function bindPiFile(row: SessionRow, session: LiveSession): boolean {
    const file = session.piFile();
    const piSessionId = session.piSessionId();
    if (!file || !piSessionId || fileSizeOrZero(file) === 0) return false;
    if (!isPiSessionFile(deps.agentDir, file)) {
      deps.logger.warn("session_file_refused", { sessionId: row.id });
      return true;
    }
    try {
      deps.store.bindPiFile(row.id, file, piSessionId);
    } catch (error) {
      deps.logger.warn("session_file_not_bound", { sessionId: row.id, err: error });
    }
    return true;
  }

  function recordEvent(sessionId: string, kind: string, data: unknown): void {
    try {
      if (kind === "policy" || kind === "taint") {
        const row = deps.store.get(sessionId);
        if (!row) deps.logger.warn("session_event_dropped", { sessionId, kind });
        else if (kind === "policy") deps.onPolicyRecord(row, data);
        else if (typeof data === "number") deps.onTaint(row, data);
        else deps.logger.warn("worker_record_dropped", { sessionId, kind });
        return;
      }
      deps.store.appendEvent(sessionId, kind, data, deps.clock.now());
    } catch (error) {
      deps.logger.warn("session_event_dropped", { sessionId, kind, err: error });
    }
  }

  function syncName(sessionId: string, name: string | null): void {
    try {
      deps.store.setName(sessionId, name);
    } catch (error) {
      deps.logger.warn("session_name_not_stored", { sessionId, err: error });
    }
  }

  function replayPreReady(sessionId: string, held: ReturnType<PreReadyBuffer["drain"]>): void {
    for (const item of held.items) {
      if (item.kind === "publish") deps.hub.publish("session", sessionId, item.event);
      else recordEvent(sessionId, item.recordKind, item.data);
    }
    if (held.dropped > 0)
      deps.logger.warn("session_start_events_dropped", { sessionId, dropped: held.dropped });
  }

  return { bindPiFile, recordEvent, syncName, replayPreReady };
}
