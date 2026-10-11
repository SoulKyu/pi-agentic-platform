import { randomInt } from "node:crypto";
import { rmSync } from "node:fs";
import { PapError, UI_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { nameOf } from "./names.ts";
import { isPiSessionFile } from "./pi-files.ts";
import { ForkRefusal, type PiWriter } from "./pi-writer.ts";
import { clipJsonText } from "./service-reads.ts";
import type { SessionRow, SessionsStore } from "./store.ts";

/** A text is sent whole in the answer; once JSON-encoded it must stay well inside the 1 MiB frame. */
const FORK_TEXT_BYTES = 800_000;
const NAME_CODE_POINTS = 40;
const COPY_SUFFIX = / · [0-9a-f]{4}$/;

/**
 * The name of a clone: the source's title on one line, an earlier " · xxxx" dropped, cut to 40 code points (an
 * ellipsis in the last place, never half a surrogate pair), then " · " and 4 random lowercase hex digits. Null when the
 * source has no title.
 */
export function cloneName(sourceTitle: string | null): string | null {
  const flat = nameOf(sourceTitle)?.replace(COPY_SUFFIX, "").trimEnd();
  if (!flat) return null;
  const points = [...flat];
  const cut = points.length > NAME_CODE_POINTS ? `${points.slice(0, NAME_CODE_POINTS - 1).join("")}…` : flat;
  return `${cut} · ${randomInt(0x10000).toString(16).padStart(4, "0")}`;
}

export interface ForksDeps {
  readonly store: SessionsStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly agentDir: string;
  newId(): string;
  loadWriter(): Promise<PiWriter>;
}

export interface Forks {
  /** The row of a new session cut before a user message of the branch, and the message's text for the composer. */
  fork(row: SessionRow, entryId: string): Promise<{ sessionId: string; text: string }>;
  /** The row of a new session that copies the branch ending at `leafId` (the file's last entry when it is not there). */
  clone(row: SessionRow, leafId: string | null): Promise<{ sessionId: string }>;
}

export function createForks(deps: ForksDeps): Forks {
  const failed = (row: SessionRow, error: unknown): PapError => {
    if (error instanceof PapError) return error;
    if (error instanceof ForkRefusal) {
      if (error.refusal === "not_a_user_message") return new PapError("bad_request");
      if (error.refusal === "empty") return new PapError("session_empty");
      // A resource limit, like a full table of workers: the client may show it as "too big", not as "nothing there".
      if (error.refusal === "too_large") {
        deps.logger.warn("fork_source_too_large", { sessionId: row.id });
        return new PapError("capacity");
      }
      // `lineage_mismatch` was logged where it was found.
      if (error.refusal === "unreadable") deps.logger.warn("fork_source_unreadable", { sessionId: row.id });
      return new PapError("internal");
    }
    deps.logger.error("fork_failed", { sessionId: row.id, err: error });
    return new PapError("internal");
  };

  // The file is Pi's, made by Pi's own manager; before the daemon remembers it, it must be where Pi keeps sessions.
  function adopt(
    source: SessionRow,
    made: { file: string | null; piSessionId: string | null },
    name: string | null,
  ): string {
    const now = deps.clock.now();
    const id = deps.newId();
    try {
      if (made.file !== null && (made.piSessionId === null || !isPiSessionFile(deps.agentDir, made.file))) {
        deps.logger.warn("fork_file_refused", { sessionId: source.id });
        throw new PapError("internal");
      }
      deps.store.insert({
        id,
        piPath: made.file,
        piSessionId: made.file === null ? null : made.piSessionId,
        cwd: source.cwd,
        ownerId: source.ownerId,
        name,
        createdAt: now,
        updatedAt: now,
      });
    } catch (error) {
      if (made.file !== null) rmSync(made.file, { force: true });
      if (error instanceof PapError) throw error;
      deps.logger.error("fork_row_not_stored", { sessionId: source.id, err: error });
      throw new PapError("internal");
    }
    return id;
  }

  return {
    async fork(row, entryId) {
      if (row.piPath === null) throw new PapError("session_empty");
      const writer = await deps.loadWriter();
      try {
        const made = writer.fork(row.piPath, entryId);
        let text: string;
        try {
          text = clipJsonText(made.text.slice(0, UI_LIMITS.editorText), FORK_TEXT_BYTES).text;
        } catch (error) {
          // The file exists already and no row will point at it.
          if (made.file !== null) rmSync(made.file, { force: true });
          throw error;
        }
        return { sessionId: adopt(row, made, null), text };
      } catch (error) {
        throw failed(row, error);
      }
    },
    async clone(row, leafId) {
      if (row.piPath === null) throw new PapError("session_empty");
      const writer = await deps.loadWriter();
      try {
        const name = cloneName(row.name);
        return { sessionId: adopt(row, writer.clone(row.piPath, leafId, name), name) };
      } catch (error) {
        throw failed(row, error);
      }
    },
  };
}
