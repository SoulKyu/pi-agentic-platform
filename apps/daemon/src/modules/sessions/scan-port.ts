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
  touched(sessionId: string, at: number, active: boolean): void;
  named(sessionId: string, raw: string | null): void;
  previewed(sessionId: string, text: string): void;
  /** A session's sidebar summary, only when `ownerId` owns it. */
  summary(sessionId: string, ownerId: string): ShellSession | null;
}

interface Adopted {
  readonly row: SessionRow;
  readonly projectId: string | null;
}

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
}): SessionsScanPort {
  const { store } = deps;
  const limiter = createRateLimiter(deps.clock, 60_000);
  const say = (event: string, fields: Record<string, unknown>) => {
    const said = limiter.check(event);
    if (said.allowed) deps.logger.warn(event, { ...fields, suppressed: said.suppressed });
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
    touched(sessionId, at, active) {
      if (store.readOnly) return;
      const row = store.get(sessionId);
      if (!row) return;
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
      const preview = cleanLabel(text, SHELL_LIMITS.preview);
      if (preview !== null && store.marks.setPreview(sessionId, preview)) deps.publisher.changed(sessionId);
    },
    summary: deps.summary,
  };
}
