import { describe, expect, it } from "vitest";
import { createRing, RING_CHUNK_BYTES, RING_MAX_BYTES, RING_MAX_LINES } from "./ring.ts";

const KIB = 1024;
const MIB = KIB * KIB;
const bytes = (text: string) => new TextEncoder().encode(text);

describe("ring bounds", () => {
  it("keeps at most 4 MiB while 5 MiB arrive in 100 KiB chunks, start advancing by exactly the evicted bytes", () => {
    const ring = createRing();
    let appended = 0;
    while (appended < 5 * MIB) {
      ring.append(new Uint8Array(100 * KIB).fill(0x61));
      appended += 100 * KIB;
      expect(ring.end).toBe(appended);
      expect(ring.end - ring.start).toBeLessThanOrEqual(RING_MAX_BYTES);
    }
    expect(RING_MAX_BYTES).toBe(4 * MIB);
    expect(ring.end).toBe(appended);
    expect(ring.start + ring.byteLength).toBe(ring.end);
    expect(ring.start).toBeGreaterThan(0);
    expect(ring.chunkSizes().every((size) => size <= RING_CHUNK_BYTES)).toBe(true);
    expect(RING_CHUNK_BYTES).toBe(64 * KIB);
    expect(ring.chunkSizes().reduce((a, b) => a + b, 0)).toBe(ring.end - ring.start);
  });

  it("keeps 5 000 lines when 5 001 one-line chunks arrive", () => {
    const ring = createRing();
    const line = `${"x".repeat(299)}\n`;
    for (let i = 0; i < 5001; i++) ring.append(bytes(line));
    expect(RING_MAX_LINES).toBe(5000);
    expect(ring.lines).toBe(5000);
    expect(ring.start).toBe(300);
    expect(ring.end).toBe(5001 * 300);
  });

  it("coalesces tiny appends into few chunks so the chunk count stays bounded", () => {
    const ring = createRing();
    for (let i = 0; i < 10_000; i++) ring.append(bytes("a"));
    expect(ring.end).toBe(10_000);
    expect(ring.chunkSizes().length).toBeLessThanOrEqual(10_000 / 256 + 1);
  });

  it("splits an append larger than a chunk and keeps the offsets exact", () => {
    const ring = createRing();
    ring.append(new Uint8Array(150 * KIB).fill(1));
    expect(ring.chunkSizes()).toEqual([64 * KIB, 64 * KIB, 22 * KIB]);
    expect(ring.end).toBe(150 * KIB);
  });
});

describe("ring read", () => {
  it("returns the exact bytes across chunk boundaries, capped by max", () => {
    const ring = createRing();
    const all = Uint8Array.from({ length: 200 * KIB }, (_, i) => i % 251);
    ring.append(all);
    expect(ring.read(64 * KIB - 3, 10)).toEqual(all.slice(64 * KIB - 3, 64 * KIB + 7));
    expect(ring.read(0, 3 * 64 * KIB)).toEqual(all.slice(0, 3 * 64 * KIB));
    expect(ring.read(ring.end, 10)).toEqual(new Uint8Array(0));
    expect(ring.read(200 * KIB - 2, 100)).toEqual(all.slice(200 * KIB - 2));
  });

  it("throws below start and past end", () => {
    const ring = createRing();
    for (let i = 0; i < 70; i++) ring.append(new Uint8Array(64 * KIB));
    expect(ring.start).toBeGreaterThan(0);
    expect(() => ring.read(ring.start - 1, 10)).toThrow(RangeError);
    expect(() => ring.read(ring.end + 1, 10)).toThrow(RangeError);
    expect(ring.read(ring.start, 1).byteLength).toBe(1);
  });
});

describe("ring safeStart", () => {
  const CHUNK = 64 * KIB;
  /** A ring whose first chunk was evicted: `second` is now the first chunk, at offset 64 KiB. */
  function evicted(second: Uint8Array) {
    const ring = createRing();
    ring.append(new Uint8Array(CHUNK).fill(0x61));
    ring.append(second);
    for (let i = 0; i < 63; i++) ring.append(new Uint8Array(CHUNK).fill(0x62));
    return ring;
  }
  const block = (head: ArrayLike<number>, fill = 0x64) => {
    const out = new Uint8Array(CHUNK).fill(fill);
    out.set(head, 0);
    return out;
  };

  it("is start while nothing was evicted, even in the middle of an escape sequence", () => {
    const ring = createRing();
    ring.append(bytes("0;32mgreen\nnext"));
    expect(ring.start).toBe(0);
    expect(ring.safeStart()).toBe(0);
  });

  it("skips the three continuation bytes of a 4-byte emoji cut by the eviction, and nothing more", () => {
    const ring = evicted(block(bytes("😀").slice(1)));
    expect(ring.start).toBe(CHUNK);
    expect(ring.safeStart()).toBe(CHUNK + 3);
  });

  it("skips at most 3 continuation bytes", () => {
    const ring = evicted(block([0x80, 0x80, 0x80, 0x80]));
    expect(ring.safeStart()).toBe(CHUNK + 3);
  });

  it("moves past the first newline of the first chunk once something was evicted", () => {
    const text = bytes("\x1b[0;32mgreen\nnext");
    const ring = evicted(block(text));
    expect(ring.start).toBe(CHUNK);
    expect(ring.safeStart()).toBe(CHUNK + text.indexOf(0x0a) + 1);
    expect(new TextDecoder().decode(ring.read(ring.safeStart(), 4))).toBe("next");
  });

  it("uses only the UTF-8 rule when the first chunk holds no newline", () => {
    const ring = evicted(block([], 0x65));
    expect(ring.safeStart()).toBe(CHUNK);
  });
});
