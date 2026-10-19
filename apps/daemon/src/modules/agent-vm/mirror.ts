import { closeSync, constants, fstatSync, readSync, rmSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { MAX_SESSION_LINE_BYTES, type SessionAppend } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { ensureFolder, existsNoFollow, openPrivate } from "./mirror-files.ts";
import { keepCopy } from "./mirror-keep.ts";
import {
  MAX_MIRROR_IDS,
  type MirrorScan,
  scanMirror,
  UNVERIFIED_MAX_BYTES,
  type Unverified,
  unverifiedIds,
  unverifiedPathOf,
} from "./mirror-facts.ts";
import {
  type Checked,
  checkMirrorLine,
  HEADER_MAX_BYTES,
  INLINE_PARSE_BYTES,
  type MirrorRefusal,
  type Provenance,
} from "./mirror-line.ts";
import { topLevelIdOf } from "./mirror-id.ts";
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
  /** Tests: the cap on ids per file (AVM-E23). */
  readonly maxIds?: number;
}

/** What a chunk's lines leave to commit once all of them passed. */
interface Staged {
  first: boolean;
  lastId: string | null;
  readonly ids: Set<string>;
  readonly users: Array<{ id: string; hash: string; line: number }>;
}

interface Replacement {
  readonly kept: string;
  readonly fd: number;
  readonly oldSize: number;
  /** The old copy's verdicts: a line inside the old size keeps its verdict instead of asking the provenance again. */
  readonly inherited: Unverified;
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
  const maxIds = deps.maxIds ?? MAX_MIRROR_IDS;
  ensureFolder(dirname(path));
  if (deps.createOnly === true && existsNoFollow(path)) throw new Error("the mirror file exists");
  let fd = openPrivate(path, READ_WRITE);
  let scan: MirrorScan;
  try {
    scan = scanMirror(fd, maxIds);
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
  /** The new file reached the old size byte for byte, all of it on disk: an extension, nothing to keep. */
  const settleExtension = (): void => {
    const current = replacement;
    if (current === null) return;
    releaseReplacement();
    try {
      rmSync(current.kept, { force: true });
      rmSync(`${current.kept}.unverified`, { force: true });
    } catch (error) {
      logger.warn("agent_mirror_keep_not_removed", { agentId, err: error });
    }
    deps.quota.forget(agentId);
  };
  /** Whether the committed bytes `data` at `position` are the old copy's bytes there (read only; nothing settles here). */
  const matchesOld = (data: Buffer, position: number): boolean => {
    const current = replacement;
    if (current === null) return true;
    const end = Math.min(position + data.length, current.oldSize);
    if (end <= position) return true;
    const old = Buffer.allocUnsafe(end - position);
    return (
      readSync(current.fd, old, 0, old.length, position) === old.length &&
      old.equals(data.subarray(0, old.length))
    );
  };

  /**
   * `replace: true` at offset 0: the current mirror (and its unverified list) is kept aside and the new file starts empty.
   * Descriptors are opened before the old one is closed, and any failure counts as a kept copy with its notice and taint (R14).
   */
  const startOver = (): void => {
    settleKept();
    partial.length = 0;
    partialLength = 0;
    let next: Replacement | null = null;
    let newFd = fd;
    if (size > 0) {
      let keptFd: number | null = null;
      try {
        const kept = keepCopy(path, deps.clock);
        keptFd = openPrivate(kept, constants.O_RDONLY);
        const inherited = unverifiedIds(kept);
        newFd = openPrivate(path, READ_WRITE);
        next = { kept, fd: keptFd, oldSize: size, inherited };
      } catch (error) {
        if (keptFd !== null) closeSync(keptFd);
        logger.warn("agent_mirror_replaced", { agentId, failed: true });
        announce("replaced");
        throw error;
      }
      closeSync(fd);
    }
    fd = newFd;
    replacement = next;
    ids = new Set();
    first = true;
    size = 0;
    lastEntryId = null;
  };

  /** Appends to the unverified list, before the lines it describes are written. False when the list would pass its bound. */
  const appendUnverified = (listed: readonly string[]): boolean => {
    const text = Buffer.from(listed.map((id) => `${id}\n`).join(""));
    const list = openPrivate(
      unverifiedPathOf(path),
      constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
    );
    try {
      if (fstatSync(list).size + text.length > UNVERIFIED_MAX_BYTES) return false;
      writeAll(list, text);
      return true;
    } finally {
      closeSync(list);
    }
  };

  /** One completed line: its facts, or the refusal. Nothing is committed here. */
  const accept = (line: Buffer, checked: Checked, staged: Staged, index: number): "refused" | null => {
    if (!checked.ok) return refuse(checked.reason);
    const { id, userText, headerId } = checked.facts;
    if (id === null && line.length > HEADER_MAX_BYTES) return refuse("line_too_large");
    // AVM-E27: the id JSON.parse gave must be the one the byte scanner finds at the top level (so the open scan, which only
    // scans, reads the same id, and a duplicate `id` key or an `id` nested in `data` cannot give a line two).
    if (id !== null && topLevelIdOf(line) !== id) return refuse("not_entry");
    const entryId = id ?? headerId;
    if (entryId !== null) {
      if (ids.has(entryId) || staged.ids.has(entryId)) return refuse("duplicate_id");
      // A flat copy: no reference to the line's bytes or head.
      const kept = Buffer.from(entryId, "latin1").toString("latin1");
      staged.ids.add(kept);
      staged.lastId = kept;
    }
    if (userText !== null && id !== null) staged.users.push({ id, hash: userText, line: index });
    staged.first = false;
    return null;
  };

  const full = (): "refused" => {
    announce("quota");
    return refuse("quota");
  };

  const commit = (lines: readonly Buffer[], staged: Staged): AppendResult => {
    if (lines.length === 0) return "ok";
    if (ids.size + staged.ids.size > maxIds) return full();
    const bytes = Buffer.concat(lines.flatMap((line) => [line, NEWLINE_BYTE]));
    // The old copy decides a verdict only for bytes that really are the old copy's.
    const same = matchesOld(bytes, size);
    const ends: number[] = [];
    for (let end = size, index = 0; index < lines.length; index++) {
      end += (lines[index] as Buffer).length + 1;
      ends.push(end);
    }
    const unsent: string[] = [];
    for (const user of staged.users) {
      const old = replacement;
      if (same && old !== null && (ends[user.line] as number) <= old.oldSize) {
        if (old.inherited.all || old.inherited.ids.has(user.id)) unsent.push(user.id);
      } else if (!deps.provenance.verify(user.hash)) unsent.push(user.id);
    }
    const listText = unsent.map((id) => `${id}\n`).join("");
    if (!deps.quota.allow(agentId, bytes.length + listText.length, deps.limitBytes)) return full();
    // The list first: if it cannot be written, the line is not (a line without its mark would read as sent).
    if (unsent.length > 0 && !appendUnverified(unsent)) return full();
    writeAll(fd, bytes);
    const before = size;
    size += bytes.length;
    deps.quota.added(agentId, bytes.length + listText.length);
    for (const id of staged.ids) ids.add(id);
    lastEntryId = staged.lastId ?? lastEntryId;
    first = staged.first;
    // Only bytes that are on disk settle a replacement (R14): a refused or unfinished chunk leaves the copy kept.
    if (replacement !== null) {
      if (!same) settleKept();
      else if (before + bytes.length >= replacement.oldSize) settleExtension();
    }
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
            return accept(line, checked, staged, index) ?? consume(lines, index + 1, staged);
          } catch (error) {
            return fail(error);
          }
        });
      }
      const refused = accept(line, checkMirrorLine(line, staged.first), staged, index);
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
