import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import type { FileHandle } from "node:fs/promises";
import { FILE_LIMITS, type FileMeta } from "@pap/contracts";
import type { Scope } from "../../kernel/fs/boundary.ts";
import { openRegularFile } from "../../kernel/fs/safe-open.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { type FilesEnv, judged, refusal } from "./access.ts";

/** A NUL in this many first bytes makes a file binary (M8R26). */
const BINARY_PROBE_BYTES = 8 * 1024;
/** The smallest chunk a page that does not fit is cut to. */
const MIN_CHUNK_BYTES = 4 * 1024;

export interface ReadAnswer {
  readonly meta: FileMeta;
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
}

/**
 * Up to `length` bytes from `position`, stopping at the end of the file. Never trusts `st_size` (procfs reports 0): it
 * reads until a short read (carry 10).
 */
async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Where a chunk of `body` cut at `limit` ends: the next chunk starts at a character, not inside a UTF-8 sequence. */
function characterBoundary(body: Buffer, limit: number): number {
  let end = limit;
  // A sequence has at most 3 continuation bytes after its lead byte.
  for (let back = 0; back < 3 && end > 0 && isContinuation(body[end] ?? 0); back++) end -= 1;
  return end;
}

/** Where the text starts: an offset inside a character moves on to the next one. */
function startOf(window: Buffer, offset: number): number {
  let skip = 0;
  while (skip < 3 && skip < window.length && isContinuation(window[skip] ?? 0)) skip++;
  return offset === 0 ? 0 : skip;
}

export async function readChunk(env: FilesEnv, scope: Scope, path: string, offset = 0): Promise<ReadAnswer> {
  const target = await judged(env, scope, path, "read");
  let handle: FileHandle;
  try {
    handle = await openRegularFile(target.real, target.guard);
  } catch (error) {
    throw refusal(error, env.logger);
  }
  try {
    const st = await handle.stat();
    const probe = await readAt(handle, 0, BINARY_PROBE_BYTES);
    const binary = probe.includes(0);
    // A file that may be small is read whole: its etag and its editability need all of it. st_size is only a hint.
    const head =
      st.size <= FILE_LIMITS.editableBytes ? await readAt(handle, 0, FILE_LIMITS.editableBytes + 1) : null;
    const whole = head !== null && head.length <= FILE_LIMITS.editableBytes ? head : null;
    const wholeText = whole !== null && !binary && isUtf8(whole) ? whole.toString("utf8") : null;
    const meta: FileMeta = {
      path,
      size: whole?.length ?? Math.max(st.size, head?.length ?? 0),
      mtimeMs: Math.max(0, st.mtimeMs), // the contract refuses a time before 1970
      etag: whole === null ? null : createHash("sha256").update(whole).digest("hex").slice(0, 32),
      binary,
      editable: wholeText !== null && sizeOf(wholeText) <= PAGE_BYTES,
      protection: target.protection,
    };
    if (binary) return { meta, text: "", offset, nextOffset: null };
    let limit: number = FILE_LIMITS.readChunkBytes;
    for (;;) {
      // Up to 3 bytes before the offset's character and 4 past the chunk tell where characters begin and end.
      const window =
        whole === null ? await readAt(handle, offset, limit + 4) : whole.subarray(offset, offset + limit + 4);
      const skip = startOf(window, offset);
      const body = window.subarray(skip);
      const full = body.length > limit;
      const end = full ? characterBoundary(body, limit) : body.length;
      const answer: ReadAnswer = {
        meta,
        text: body.subarray(0, end).toString("utf8"),
        offset: offset + skip,
        nextOffset: full ? offset + skip + end : null,
      };
      if (sizeOf(answer) <= PAGE_BYTES || limit <= MIN_CHUNK_BYTES) return answer;
      limit = Math.max(MIN_CHUNK_BYTES, Math.floor(limit / 2));
    }
  } catch (error) {
    throw refusal(error, env.logger);
  } finally {
    await handle.close();
  }
}

/** A regular file the caller may read, open at its size now, for the raw route (M8R32). The caller closes `handle`. */
export async function openRaw(
  env: FilesEnv,
  scope: Scope,
  path: string,
): Promise<{ readonly handle: FileHandle; readonly size: number }> {
  const target = await judged(env, scope, path, "read");
  let handle: FileHandle | undefined;
  try {
    handle = await openRegularFile(target.real, target.guard);
    return { handle, size: (await handle.stat()).size };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw refusal(error, env.logger);
  }
}
