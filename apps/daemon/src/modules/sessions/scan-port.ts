import { SHELL_LIMITS, type ShellSession } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createRateLimiter } from "../../kernel/rate-limit.ts";
import { cleanLabel } from "../../kernel/text.ts";
import { nameOf } from "./names.ts";
import { isPiSessionFile } from "./pi-files.ts";
import type { ShellPublisher } from "./shell-publisher.ts";
import type { SessionRow, SessionsStore } from "./store.ts";

export interface PiFileHeader {
  readonly id: string;
  readonly cwd: string;
  readonly createdAt: number;
}

export type Claim =
  | { readonly kind: "session"; readonly sessionId: string; readonly ownerId: string }
  | { readonly kind: "wait" }
  | { readonly kind: "skip"; readonly reason: "duplicate_id" | "not_pi_file" };

/** What the scanner (search module) may ask of sessions: nothing else of the sessions table is reachable. */
export interface SessionsScanPort {
  claim(path: string, header: PiFileHeader): Claim;
  /**
   * `toolResults`: entries read on from a stored cursor held a tool result, or a line that could not be read (Q5).
   * It taints the session when the write is outside pap, by the same test as `outsideWriteAt`.
   */
  touched(sessionId: string, at: number, active: boolean, toolResults: boolean): void;
  named(sessionId: string, raw: string | null): void;
  previewed(sessionId: string, text: string): void;
  /** A session's sidebar summary, only when `ownerId` owns it. */
  summary(sessionId: string, ownerId: string): ShellSession | null;
}

interface Adopted {
  readonly row: SessionRow;
  readonly projectId: string | null;
}

// The fence around outside text (a webhook payload): a tab shows the words, not the markup. Plain text stays plain.
const FENCE_TAG = /<\/?untrusted\b[^>]*>/g;

/** Sessions whose latest outside write is remembered; the oldest is forgotten past this (M4R141). */
export const MAX_OUTSIDE_WRITES = 1024;

export function createScanPort(deps: {
  /** The sessions table, its marks and whether it may be written (M4R124). */
  readonly store: SessionsStore;
  readonly agentDir: string;
  readonly clock: Clock;
  readonly logger: Logger;
  newId(): string;
  ownerId(): string | null;
  /** The row of a live session whose worker reported this Pi id. */
  livePiSession(piSessionId: string): SessionRow | null;
  assignProject(sessionId: string, ownerId: string, cwd: string): string | null;
  readonly publisher: ShellPublisher;
  activity(sessionId: string): void;
  summary(sessionId: string, ownerId: string): ShellSession | null;
  /** Once per row this port inserts (agreement 8); M5 wires it to `policy.markTainted`. */
  onAdopted(sessionId: string): void;
  /** A write outside pap added tool results to this session's file (M7R27); a throw reaches the scanner, which says it. */
  onOutsideToolResults(sessionId: string): void;
  /** When this daemon started: earlier writes are not shown as an outside-write notice (M4R141). The taint ignores it (MC19). */
  readonly startedAt: number;
  isLive(sessionId: string): boolean;
  /** When the session's last pap worker ended in this process. */
  workerEndedAt(sessionId: string): number | null;
}): SessionsScanPort & {
  outsideWriteAt(sessionId: string): number | null;
  /** Taints a session whose earlier taint could not be stored; throws again when it still cannot (a launch is refused). */
  settleOwed(sessionId: string): void;
} {
  const { store } = deps;
  const limiter = createRateLimiter(deps.clock, 60_000);
  const say = (event: string, fields: Record<string, unknown>) => {
    const said = limiter.check(event);
    if (said.allowed) deps.logger.warn(event, { ...fields, suppressed: said.suppressed });
  };
  // The latest write the scanner saw without a pap worker, by session (owner Q13): insertion order is age order.
  const outside = new Map<string, number>();
  const noteOutside = (sessionId: string, at: number): boolean => {
    if (deps.isLive(sessionId) || at <= Math.max(deps.startedAt, deps.workerEndedAt(sessionId) ?? 0))
      return false;
    outside.delete(sessionId);
    outside.set(sessionId, at);
    if (outside.size > MAX_OUTSIDE_WRITES) outside.delete(outside.keys().next().value as string);
    return true;
  };
  // Sessions whose taint could not be stored: the scanner keeps its position and asks again, and the taint is made even
  // if a pap worker holds the session by then. Full: a new failure is not added (the position stays unsaved all the same).
  const owed = new Set<string>();
  const taint = (sessionId: string): void => {
    try {
      deps.onOutsideToolResults(sessionId);
    } catch (error) {
      if (owed.size < MAX_OUTSIDE_WRITES) owed.add(sessionId);
      else say("session_taint_owed_full", {});
      throw error;
    }
    owed.delete(sessionId);
  };
  const duplicate = (): Claim => {
    say("session_file_duplicate_id", {});
    return { kind: "skip", reason: "duplicate_id" };
  };
  const bind = (row: { id: string; ownerId: string }, path: string, piId: string): Claim =>
    store.bindPiFile(row.id, path, piId)
      ? { kind: "session", sessionId: row.id, ownerId: row.ownerId }
      : duplicate();
  const decide = (path: string, header: PiFileHeader): Claim | Adopted => {
    const byPath = store.marks.findByPiPath(path);
    if (byPath) return { kind: "session", sessionId: byPath.id, ownerId: byPath.ownerId };
    if (store.marks.findByPiSessionId(header.id)) return duplicate();
    if (!isPiSessionFile(deps.agentDir, path)) return { kind: "skip", reason: "not_pi_file" };
    const live = deps.livePiSession(header.id);
    if (live) return bind(live, path, header.id);
    // A draft whose worker reported this id before Pi wrote the file: from the table, so a restart forgets nothing (RT-01).
    const draft = store.marks.findByPendingPiId(header.id);
    if (draft) return draft.piPath === null ? bind(draft, path, header.id) : duplicate();
    const ownerId = deps.ownerId();
    if (ownerId === null) return { kind: "wait" };
    const at = Math.min(header.createdAt, deps.clock.now());
    const row: SessionRow = {
      id: deps.newId(),
      piPath: path,
      piSessionId: header.id,
      cwd: header.cwd,
      ownerId,
      name: null,
      createdAt: at,
      updatedAt: at,
    };
    // One transaction: a hook that throws (M5 taints in the database) leaves no row, so the next pass adopts it again.
    const projectId = store.transaction(() => {
      store.insert(row, null);
      const assigned = deps.assignProject(row.id, ownerId, row.cwd);
      deps.onAdopted(row.id);
      return assigned;
    });
    return { row, projectId };
  };
  return {
    // Synchronous on purpose: no await between a check and the insert, so one file never becomes two sessions (M4R60).
    claim(path, header) {
      if (store.readOnly) return { kind: "wait" };
      let decided: Claim | Adopted;
      try {
        decided = decide(path, header);
      } catch (error) {
        // Nothing was written (the insert, its project and the hook are one transaction): the next pass tries again.
        say("session_claim_failed", { err: error });
        return { kind: "wait" };
      }
      if (!("row" in decided)) return decided;
      const { row, projectId } = decided;
      deps.publisher.changed(row.id);
      deps.publisher.projectChanged(row.ownerId, projectId);
      deps.logger.info("session_adopted", { sessionId: row.id });
      return { kind: "session", sessionId: row.id, ownerId: row.ownerId };
    },
    touched(sessionId, at, active, toolResults) {
      noteOutside(sessionId, Math.trunc(at));
      if (store.readOnly) return;
      const row = store.get(sessionId);
      if (!row) return;
      // First, so that nothing before it can lose the taint. Not the notice's test: pap's own last writes are stamped in
      // the table, so a write made while pap was down is outside, and a restart does not make pap's own tail outside (MC19).
      const wrote = store.papWrote(sessionId);
      const outsideForTaint =
        !deps.isLive(sessionId) &&
        Math.trunc(at) > Math.max(deps.workerEndedAt(sessionId) ?? 0, wrote.at ?? 0);
      if (owed.has(sessionId) || (toolResults && outsideForTaint)) taint(sessionId);
      const when = Math.min(Math.trunc(at), deps.clock.now());
      const moved = when > row.updatedAt;
      if (moved) store.touch(sessionId, when);
      if (active) deps.activity(sessionId);
      if (moved) deps.publisher.changed(sessionId);
    },
    named(sessionId, raw) {
      if (store.readOnly) return;
      const row = store.get(sessionId);
      const name = nameOf(raw);
      if (!row || row.name === name) return;
      store.setName(sessionId, name);
      deps.publisher.changed(sessionId);
    },
    previewed(sessionId, text) {
      if (store.readOnly) return;
      const preview = cleanLabel(text.replace(FENCE_TAG, " "), SHELL_LIMITS.preview);
      if (preview === null || preview === "") return;
      if (store.marks.setPreview(sessionId, preview)) deps.publisher.changed(sessionId);
    },
    summary: deps.summary,
    outsideWriteAt: (sessionId) => outside.get(sessionId) ?? null,
    settleOwed(sessionId) {
      if (owed.has(sessionId)) taint(sessionId);
    },
  };
}
