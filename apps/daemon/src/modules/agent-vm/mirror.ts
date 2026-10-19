import { closeSync, constants, readSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { MAX_SESSION_LINE_BYTES, type SessionAppend } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { ensureFolder, existsNoFollow, openPrivate } from "./mirror-files.ts";
import { keepCopy } from "./mirror-keep.ts";
import { type MirrorScan, scanMirror, unverifiedPathOf } from "./mirror-facts.ts";
import {
  type Checked,
  checkMirrorLine,
  headIdOf,
  INLINE_PARSE_BYTES,
  type MirrorRefusal,
  type Provenance,
} from "./mirror-line.ts";
import type { LineParser } from "./mirror-parse.ts";
import type { Quota } from "./mirror-quota.ts";
import type { AppendResult, MirrorPort } from "./vm-worker.ts";

/** R14: said to the thread when the VM rewrote a conversation. */
export const REPLACED_NOTICE = "La VM a réécrit cette conversation ; l'ancienne copie est gardée 7 jours.";

const NEWLINE = 0x0a;
const NEWLINE_BYTE = Buffer.from([NEWLINE]);
const READ_WRITE = constants.O_RDWR | constants.O_CREAT | constants.O_APPEND;

export interface MirrorDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly agentId: string;
  readonly parser: Pick<LineParser, "parse">;
  readonly provenance: Pick<Provenance, "verify">;
  readonly quota: Quota;
  /** The agent's `diskMb`, in bytes. */
  readonly limitBytes: number;
  /** What the session must hear: a replacement (the notice, and the taint) or a full disk (the notice). */
  announce(kind: "replaced" | "quota"): void;
  /** A new session's file: it must not exist yet, or it could be another session's mirror. */
  readonly createOnly?: boolean;
}

/** What a chunk's lines leave to commit once all of them passed. */
interface Staged {
  first: boolean;
  lastId: string | null;
  readonly ids: Set<string>;
  readonly users: Array<{ id: string; hash: string }>;
}

interface Replacement {
  readonly kept: string;
  readonly fd: number;
  readonly oldSize: number;
}

function writeAll(fd: number, bytes: Buffer): void {
  for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written);
}

/**
 * The host's copy of one VM session file (R23). It is fed by the worker's `session_append` chunks (raw byte ranges that can
 * end mid-line), writes complete lines only, and checks every one (R1, R14, R32): shape, size, duplicate ids, quota and
 * provenance. It does not trust the VM: a refusal logs `agent_mirror_refused` and the worker's connection is closed by the
 * caller. A refused chunk writes nothing. Throws when the folder or the file is a link or not the daemon's own.
 */
export function openMirror(path: string, deps: MirrorDeps): MirrorPort {
  const name = basename(path);
  const { agentId, logger } = deps;
  ensureFolder(dirname(path));
  if (deps.createOnly === true && existsNoFollow(path)) throw new Error("the mirror file exists");
  let fd = openPrivate(path, READ_WRITE);
  let scan: MirrorScan;
  try {
    scan = scanMirror(fd);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  let { size, lastEntryId } = scan;
  let ids = scan.ids;
  let first = size === 0;
  const partial: Buffer[] = [];
  let partialLength = 0;
  let replacement: Replacement | null = null;
  let closed = false;
  let dead = false;

  const refuse = (reason: MirrorRefusal): "refused" => {
    dead = true;
    logger.warn("agent_mirror_refused", { agentId, reason });
    return "refused";
  };
  const announce = (kind: "replaced" | "quota"): void => {
    try {
      deps.announce(kind);
    } catch (error) {
      logger.warn("agent_mirror_announce_failed", { agentId, kind, err: error });
    }
  };

  const releaseReplacement = (): void => {
    if (replacement === null) return;
    try {
      closeSync(replacement.fd);
    } catch {
      // Already closed.
    }
    replacement = null;
  };
  /** The new file differs from the old one, or the connection ended before it caught up: the old copy stays (R14). */
  const settleKept = (): void => {
    if (replacement === null) return;
    releaseReplacement();
    logger.warn("agent_mirror_replaced", { agentId });
    announce("replaced");
  };
  /** The new file reached the old size byte for byte: an extension, nothing to keep. */
  const settleExtension = (): void => {
    const current = replacement;
    if (current === null) return;
    releaseReplacement();
    try {
      unlinkSync(current.kept);
    } catch (error) {
      logger.warn("agent_mirror_keep_not_removed", { agentId, err: error });
    }
    deps.quota.forget(agentId);
  };
  const compare = (data: Buffer, position: number): void => {
    const current = replacement;
    if (current === null) return;
    const end = Math.min(position + data.length, current.oldSize);
    if (end > position) {
      const old = Buffer.allocUnsafe(end - position);
      if (readSync(current.fd, old, 0, old.length, position) !== old.length) return settleKept();
      if (!old.equals(data.subarray(0, old.length))) return settleKept();
    }
    if (position + data.length >= current.oldSize) settleExtension();
  };

  /** `replace: true` at offset 0: the current mirror is kept aside and the new file starts empty. */
  const startOver = (): void => {
    settleKept();
    closeSync(fd);
    partial.length = 0;
    partialLength = 0;
    if (size > 0) {
      const kept = keepCopy(path, deps.clock);
      replacement = { kept, fd: openPrivate(kept, constants.O_RDONLY), oldSize: size };
    }
    fd = openPrivate(path, READ_WRITE);
    try {
      unlinkSync(unverifiedPathOf(path));
    } catch {
      // No list yet.
    }
    ids = new Set();
    first = true;
    size = 0;
    lastEntryId = null;
  };

  const appendUnverified = (listed: readonly string[]): void => {
    const list = openPrivate(
      unverifiedPathOf(path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    );
    try {
      writeAll(list, Buffer.from(listed.map((id) => `${id}\n`).join("")));
    } finally {
      closeSync(list);
    }
  };

  /** One completed line: its facts, or the refusal. Nothing is committed here. */
  const accept = (line: Buffer, checked: Checked, staged: Staged): "refused" | null => {
    if (!checked.ok) return refuse(checked.reason);
    const { id, userText, headerId } = checked.facts;
    if (id !== null) {
      // JSON.parse keeps the last of two `id` keys, the open scan reads the first: a line where they differ is not a Pi entry.
      const head = headIdOf(line);
      if (head !== null && head !== id) return refuse("not_entry");
    }
    const entryId = id ?? headerId;
    if (entryId !== null) {
      if (ids.has(entryId) || staged.ids.has(entryId)) return refuse("duplicate_id");
      staged.ids.add(entryId);
      staged.lastId = entryId;
    }
    if (userText !== null && id !== null) staged.users.push({ id, hash: userText });
    staged.first = false;
    return null;
  };

  const commit = (lines: readonly Buffer[], staged: Staged): AppendResult => {
    if (lines.length === 0) return "ok";
    const bytes = Buffer.concat(lines.flatMap((line) => [line, NEWLINE_BYTE]));
    if (!deps.quota.allow(agentId, bytes.length, deps.limitBytes)) {
      announce("quota");
      return refuse("quota");
    }
    writeAll(fd, bytes);
    size += bytes.length;
    deps.quota.added(agentId, bytes.length);
    for (const id of staged.ids) ids.add(id);
    lastEntryId = staged.lastId ?? lastEntryId;
    first = staged.first;
    const unverified = staged.users
      .filter((user) => !deps.provenance.verify(user.hash))
      .map((user) => user.id);
    if (unverified.length > 0) appendUnverified(unverified);
    return "ok";
  };

  const fail = (error: unknown): "refused" => {
    logger.warn("agent_mirror_write_failed", { agentId, err: error });
    return refuse("file");
  };

  function consume(
    lines: readonly Buffer[],
    from: number,
    staged: Staged,
  ): AppendResult | Promise<AppendResult> {
    for (let index = from; index < lines.length; index++) {
      const line = lines[index] as Buffer;
      if (line.length > INLINE_PARSE_BYTES) {
        // R32: parsed off the event loop; the worker's connection is paused until this settles.
        return deps.parser.parse(line, staged.first).then((checked) => {
          if (closed || dead) return "refused";
          try {
            return accept(line, checked, staged) ?? consume(lines, index + 1, staged);
          } catch (error) {
            return fail(error);
          }
        });
      }
      const refused = accept(line, checkMirrorLine(line, staged.first), staged);
      if (refused !== null) return refused;
    }
    return commit(lines, staged);
  }

  function append(record: SessionAppend): AppendResult | Promise<AppendResult> {
    if (record.file !== name) return refuse("file");
    const data = Buffer.from(record.data, "base64");
    if (record.replace) {
      if (record.offset !== 0) return refuse("offset");
      startOver();
    } else if (record.offset !== size + partialLength) {
      partial.length = 0;
      partialLength = 0;
      return { resync: { type: "session_resync", fromOffset: size, lastEntryId } };
    }
    compare(data, size + partialLength);

    const lines: Buffer[] = [];
    let at = 0;
    for (let newline = data.indexOf(NEWLINE, at); newline >= 0; newline = data.indexOf(NEWLINE, at)) {
      const piece = data.subarray(at, newline);
      const line = partialLength > 0 ? Buffer.concat([...partial, piece]) : piece;
      if (line.length > MAX_SESSION_LINE_BYTES) return refuse("line_too_large");
      lines.push(line);
      partial.length = 0;
      partialLength = 0;
      at = newline + 1;
    }
    const tail = data.subarray(at);
    // No newline in sight and already past the bound: the line cannot become one the mirror accepts (R1).
    if (partialLength + tail.length > MAX_SESSION_LINE_BYTES) return refuse("line_too_large");
    if (tail.length > 0) {
      partial.push(Buffer.from(tail));
      partialLength += tail.length;
    }
    return consume(lines, 0, { first, lastId: null, ids: new Set(), users: [] });
  }

  return {
    path,
    facts: () => ({ size, lastEntryId }),
    onSessionAppend(record) {
      if (closed || dead) return "refused";
      try {
        return append(record);
      } catch (error) {
        return fail(error);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      partial.length = 0;
      partialLength = 0;
      // A replacement the connection left unfinished ended shorter than the old copy: the copy stays.
      settleKept();
      try {
        closeSync(fd);
      } catch {
        // Already closed.
      }
    },
  };
}
