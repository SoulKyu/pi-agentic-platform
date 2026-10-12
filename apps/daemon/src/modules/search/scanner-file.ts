import { closeSync } from "node:fs";
import type { Logger } from "../../kernel/logger.ts";
import { cutUnits } from "../../kernel/text.ts";
import type { SessionsScanPort } from "../sessions/index.ts";
import { extract } from "./extract.ts";
import type { FileCursor, IndexRow, SearchIndexStore } from "./index-store.ts";
import { HEAD_CHARS, openRegular, parseHeader, readHeaderLine, readLines } from "./session-file.ts";

export const STEP_BYTES = 4 * 1024 * 1024;
export const MAX_INDEXED_CHARS = 4_000_000;

export type FileOutcome =
  | { readonly kind: "gone" }
  | { readonly kind: "skipped"; readonly reason: string }
  | { readonly kind: "waiting" }
  | { readonly kind: "indexed"; readonly sessionId: string; readonly rows: number; readonly more: boolean };

export interface FileContext {
  readonly installedAt: number;
  readonly store: SearchIndexStore;
  readonly sessions: Pick<SessionsScanPort, "claim" | "touched" | "named" | "previewed">;
  readonly logger: Logger;
  /** One rate-limited warning per event name (M4R69). */
  say(event: string, fields?: Record<string, unknown>): void;
  readonly limits?: { readonly stepBytes?: number; readonly maxIndexedChars?: number };
}

/** A stable, short code for an error (an errno, a SQLite code): never its message, which may hold a path or file text. */
function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,64}$/.test(code) ? code : "error";
}

/** Rows that fit the per-file text budget, in order; the rest are dropped (M4R68). */
function withinBudget(
  rows: readonly IndexRow[],
  room: number,
): { kept: IndexRow[]; chars: number; capped: boolean } {
  const kept: IndexRow[] = [];
  let chars = 0;
  for (const row of rows) {
    if (chars + row.text.length > room) return { kept, chars, capped: true };
    chars += row.text.length;
    kept.push(row);
  }
  return { kept, chars, capped: false };
}

/** A port call whose failure costs this file nothing else: said, never thrown (RT-04). */
function attempt(ctx: FileContext, call: string, run: () => void): void {
  try {
    run();
  } catch (error) {
    ctx.say("session_file_port_failed", { call, code: codeOf(error) });
  }
}

function step(
  path: string,
  fd: number,
  stat: { ino: number; size: number; mtimeMs: number },
  ctx: FileContext,
): FileOutcome {
  let cursor = ctx.store.cursor(path);
  const unchanged =
    cursor !== undefined &&
    cursor.ino === stat.ino &&
    cursor.size === stat.size &&
    cursor.mtimeMs === stat.mtimeMs;
  if (cursor && unchanged) {
    if (cursor.state === "excluded") return { kind: "skipped", reason: "excluded" };
    if (cursor.state === "bad") return { kind: "skipped", reason: "bad_header" };
    if (cursor.state === "indexed" && cursor.sessionId !== null && cursor.offset >= stat.size)
      return { kind: "indexed", sessionId: cursor.sessionId, rows: 0, more: false };
  }
  const header = readHeaderLine(fd, stat.size);
  if (!header) return { kind: "skipped", reason: "no_header_yet" };
  const head = header.line.slice(0, HEAD_CHARS);
  // Pi only appends: another inode, a shorter file or another header is a different file (M4R66).
  if (cursor && (cursor.ino !== stat.ino || stat.size < cursor.offset || cursor.head !== head)) {
    ctx.store.forget(path);
    cursor = undefined;
  }
  const base = { path, ...stat, head };
  const mark = (state: FileCursor["state"], offset: number): void =>
    ctx.store.commit(
      { ...base, offset, skipLine: false, state, sessionId: null, ownerId: null, indexedChars: 0 },
      [],
    );
  const parsed = parseHeader(header.line);
  if (!parsed) {
    mark("bad", stat.size);
    ctx.say("session_file_bad_header");
    return { kind: "skipped", reason: "bad_header" };
  }
  if (parsed.createdAt < ctx.installedAt) {
    mark("excluded", stat.size);
    return { kind: "skipped", reason: "excluded" };
  }
  const known = cursor?.state === "indexed" ? cursor : undefined;
  let sessionId = known?.sessionId ?? null;
  let ownerId = known?.ownerId ?? null;
  if (sessionId === null || ownerId === null) {
    const claim = ctx.sessions.claim(path, parsed);
    if (claim.kind === "wait") {
      mark("waiting", header.end + 1);
      return { kind: "waiting" };
    }
    if (claim.kind === "skip") {
      mark("bad", stat.size);
      return { kind: "skipped", reason: claim.reason };
    }
    sessionId = claim.sessionId;
    ownerId = claim.ownerId;
  }
  const from = known ? known.offset : header.end + 1;
  // Inside a line over the cap last time: go on skipping it from there (M4R135).
  const read = readLines(fd, from, stat.size, ctx.limits?.stepBytes ?? STEP_BYTES, known?.skipLine ?? false);
  const found = extract(read.records);
  const before = known?.indexedChars ?? 0;
  const room = Math.max(0, (ctx.limits?.maxIndexedChars ?? MAX_INDEXED_CHARS) - before);
  const { kept, chars, capped } = withinBudget(found.rows, room);
  ctx.store.commit(
    {
      ...base,
      offset: read.next,
      skipLine: read.skipping,
      state: "indexed",
      sessionId,
      ownerId,
      indexedChars: before + chars,
    },
    kept,
  );
  if (capped) ctx.say("session_file_capped");
  if (read.bad > 0 || read.skipped > 0)
    ctx.say("session_file_lines_skipped", { bad: read.bad, skipped: read.skipped });
  const id = sessionId;
  if (found.name !== undefined) {
    const name = found.name;
    attempt(ctx, "named", () => ctx.sessions.named(id, name === null ? null : cutUnits(name, HEAD_CHARS)));
  }
  if (found.firstUser !== null) {
    const text = cutUnits(found.firstUser, HEAD_CHARS);
    attempt(ctx, "previewed", () => ctx.sessions.previewed(id, text));
  }
  if (read.next > from) attempt(ctx, "touched", () => ctx.sessions.touched(id, stat.mtimeMs, found.active));
  return { kind: "indexed", sessionId, rows: kept.length, more: read.next > from && read.next < stat.size };
}

/**
 * One step of one Pi file (M4R65–M4R69). Synchronous: the engine yields between calls. Any I/O or SQLite error is
 * contained here and said with its code; the cursor then stays where it was, so the next pass tries again (RT-04).
 * The path is the cursor's key and is used as given: the caller spells it as the sessions module does.
 */
export function processFile(path: string, ctx: FileContext): FileOutcome {
  try {
    const opened = openRegular(path);
    if ("refused" in opened) {
      ctx.store.forget(path);
      if (opened.refused === "ENOENT") return { kind: "gone" };
      if (opened.refused !== "ELOOP" && opened.refused !== "not_file")
        ctx.say("session_file_unreadable", { code: opened.refused });
      return { kind: "skipped", reason: opened.refused };
    }
    try {
      const { ino, size, mtimeMs } = opened;
      return step(path, opened.fd, { ino, size, mtimeMs }, ctx);
    } finally {
      closeSync(opened.fd);
    }
  } catch (error) {
    const code = codeOf(error);
    ctx.say("session_file_unreadable", { code });
    return { kind: "skipped", reason: code };
  }
}
