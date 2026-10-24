import { createHash } from "node:crypto";
import { isUtf8 } from "node:buffer";
import { closeSync, constants, fstatSync, readSync } from "node:fs";
import { FILE_CHUNK_BYTES, FILE_LIMITS, type FileMeta, PAGE_BYTES, sizeOf } from "@pap/contracts";
import { openAt } from "../../nofollow.ts";
import { inGit, type OpEnv, withParent } from "./paths.ts";

/** A NUL in this many first bytes makes a file binary. */
const BINARY_PROBE_BYTES = 8 * 1024;
/** The smallest chunk a page that does not fit is cut to. */
const MIN_CHUNK_BYTES = 4 * 1024;

export const etagOf = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 32);

/** Up to `length` bytes from `position`, stopping at the end of the file (never trusts `st_size`). */
export function readAt(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const bytes = readSync(fd, buffer, filled, length - filled, position + filled);
    if (bytes === 0) break;
    filled += bytes;
  }
  return buffer.subarray(0, filled);
}

/** Opens the regular file `path` names for reading (no link at any component), runs `use`, closes it. */
export function withFile<T>(env: OpEnv, path: string, use: (fd: number, segments: string[]) => T): T {
  return withParent(env, path, (parent, name, segments) => {
    const fd = openAt(parent, name, constants.O_RDONLY);
    try {
      return use(fd, segments);
    } finally {
      closeSync(fd);
    }
  });
}

const isContinuation = (byte: number): boolean => (byte & 0xc0) === 0x80;

/** Where a chunk of `body` cut at `limit` ends: the next chunk starts at a character, not inside a UTF-8 sequence. */
function characterBoundary(body: Buffer, limit: number): number {
  let end = limit;
  for (let back = 0; back < 3 && end > 0 && isContinuation(body[end] ?? 0); back++) end -= 1;
  return end;
}

/** Where the text starts: an offset inside a character moves on to the next one. */
function startOf(window: Buffer, offset: number): number {
  let skip = 0;
  while (skip < 3 && skip < window.length && isContinuation(window[skip] ?? 0)) skip++;
  return offset === 0 ? 0 : skip;
}

/** `fs.read`: one chunk of text with the file's meta, as the host's `files.read` answers. */
export function fsRead(
  env: OpEnv,
  args: { readonly path: string; readonly offset: number },
): { meta: FileMeta; text: string; offset: number; nextOffset: number | null } {
  const { path, offset } = args;
  return withFile(env, path, (fd, segments) => {
    const st = fstatSync(fd);
    const binary = readAt(fd, 0, BINARY_PROBE_BYTES).includes(0);
    // A file that may be small is read whole: its etag and its editability need all of it.
    const head = st.size <= FILE_LIMITS.editableBytes ? readAt(fd, 0, FILE_LIMITS.editableBytes + 1) : null;
    const whole = head !== null && head.length <= FILE_LIMITS.editableBytes ? head : null;
    const wholeText = whole !== null && !binary && isUtf8(whole) ? whole.toString("utf8") : null;
    const meta: FileMeta = {
      path,
      size: whole?.length ?? Math.max(st.size, head?.length ?? 0),
      mtimeMs: Math.max(0, st.mtimeMs),
      etag: whole === null ? null : etagOf(whole),
      binary,
      editable: wholeText !== null && sizeOf(wholeText) <= PAGE_BYTES && !inGit(segments),
      protection: inGit(segments) ? "confirm" : "none",
    };
    if (binary) return { meta, text: "", offset, nextOffset: null };
    let limit: number = FILE_LIMITS.readChunkBytes;
    for (;;) {
      const window =
        whole === null ? readAt(fd, offset, limit + 4) : whole.subarray(offset, offset + limit + 4);
      const skip = startOf(window, offset);
      const body = window.subarray(skip);
      const full = body.length > limit;
      const end = full ? characterBoundary(body, limit) : body.length;
      const answer = {
        meta,
        text: body.subarray(0, end).toString("utf8"),
        offset: offset + skip,
        nextOffset: full ? offset + skip + end : null,
      };
      if (sizeOf(answer) <= PAGE_BYTES || limit <= MIN_CHUNK_BYTES) return answer;
      limit = Math.max(MIN_CHUNK_BYTES, Math.floor(limit / 2));
    }
  });
}

/** `fs.get`: the raw bytes of a download, `FILE_CHUNK_BYTES` at a time, base64. */
export function fsGet(
  env: OpEnv,
  args: { readonly path: string; readonly offset: number },
): { data: string; size: number; nextOffset: number | null } {
  return withFile(env, args.path, (fd) => {
    const size = fstatSync(fd).size;
    const chunk = readAt(fd, args.offset, FILE_CHUNK_BYTES);
    const end = args.offset + chunk.length;
    return {
      data: chunk.toString("base64"),
      size,
      nextOffset: chunk.length === FILE_CHUNK_BYTES && end < size ? end : null,
    };
  });
}
