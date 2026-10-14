export const RING_MAX_BYTES = 4 * 1024 * 1024;
export const RING_MAX_LINES = 5000;
export const RING_CHUNK_BYTES = 64 * 1024;
/** An append joins the last chunk while that one is below this size: a stream of tiny writes cannot make millions of chunks. */
const COALESCE_BELOW = 256;
const NEWLINE = 0x0a;
/** A UTF-8 sequence is at most 4 bytes: at most 3 continuation bytes follow its lead byte. */
const MAX_CONTINUATION = 3;

interface Chunk {
  readonly offset: number;
  bytes: Uint8Array;
  lines: number;
}

export interface Ring {
  /** Offset of the first byte kept (bytes since the terminal started). */
  readonly start: number;
  /** Offset after the last byte. */
  readonly end: number;
  readonly byteLength: number;
  readonly lines: number;
  append(data: Uint8Array): void;
  /** Up to `max` bytes from `from`; throws a `RangeError` when `from` is outside `[start, end]`. */
  read(from: number, max: number): Uint8Array;
  /** Where a replay may begin: not inside a UTF-8 sequence, and past the cut-off line once something was evicted (M8R56). */
  safeStart(): number;
  chunkSizes(): number[];
}

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) count++;
  return count;
}

/** The terminal's scrollback: bounded in bytes and lines, evicting whole chunks from the front (M8R56). */
export function createRing(): Ring {
  const chunks: Chunk[] = [];
  let head = 0;
  let end = 0;
  let lines = 0;

  const live = (): number => chunks.length - head;
  const startOffset = (): number => chunks[head]?.offset ?? end;

  const evict = (): void => {
    while (live() > 1 && (end - startOffset() > RING_MAX_BYTES || lines > RING_MAX_LINES)) {
      lines -= chunks[head]?.lines ?? 0;
      head++;
    }
    if (head > 1024) {
      chunks.splice(0, head);
      head = 0;
    }
  };

  /** `bytes` is at most one chunk (the caller slices it). */
  const push = (bytes: Uint8Array): void => {
    const last = chunks.at(-1);
    if (live() > 0 && last && last.bytes.byteLength < COALESCE_BELOW) {
      const room = RING_CHUNK_BYTES - last.bytes.byteLength;
      const take = bytes.subarray(0, room);
      const joined = new Uint8Array(last.bytes.byteLength + take.byteLength);
      joined.set(last.bytes, 0);
      joined.set(take, last.bytes.byteLength);
      const added = countLines(take);
      last.bytes = joined;
      last.lines += added;
      lines += added;
      end += take.byteLength;
      if (take.byteLength < bytes.byteLength) push(bytes.subarray(take.byteLength));
      return;
    }
    const copy = new Uint8Array(bytes);
    const chunk: Chunk = { offset: end, bytes: copy, lines: countLines(copy) };
    chunks.push(chunk);
    lines += chunk.lines;
    end += copy.byteLength;
  };

  const find = (offset: number): number => {
    let low = head;
    let high = chunks.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((chunks[mid]?.offset ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low;
  };

  return {
    get start() {
      return startOffset();
    },
    get end() {
      return end;
    },
    get byteLength() {
      return end - startOffset();
    },
    get lines() {
      return lines;
    },
    append(data) {
      let rest = data;
      while (rest.byteLength > 0) {
        // One piece at a time: the eviction runs between pieces, so a huge append cannot hold more than a chunk extra.
        const take = Math.min(rest.byteLength, RING_CHUNK_BYTES);
        push(rest.subarray(0, take));
        evict();
        rest = rest.subarray(take);
      }
    },
    read(from, max) {
      if (!Number.isInteger(from) || from < startOffset() || from > end)
        throw new RangeError("ring offset out of range");
      const size = Math.max(0, Math.min(max, end - from));
      const out = new Uint8Array(size);
      let written = 0;
      for (let at = find(from); written < size && at < chunks.length; at++) {
        const chunk = chunks[at];
        if (!chunk) break;
        const skip = Math.max(0, from + written - chunk.offset);
        const piece = chunk.bytes.subarray(skip, skip + (size - written));
        out.set(piece, written);
        written += piece.byteLength;
      }
      return out;
    },
    safeStart() {
      const start = startOffset();
      const first = chunks[head];
      if (!first) return start;
      let at = 0;
      while (at < MAX_CONTINUATION && at < first.bytes.byteLength && ((first.bytes[at] ?? 0) & 0xc0) === 0x80)
        at++;
      if (start > 0) {
        const newline = first.bytes.indexOf(NEWLINE, at);
        if (newline !== -1) at = newline + 1;
      }
      return start + at;
    },
    chunkSizes: () => chunks.slice(head).map((chunk) => chunk.bytes.byteLength),
  };
}
