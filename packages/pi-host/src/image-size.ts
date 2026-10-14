/** M8R41b (RT-26): what an image declares, read from its header before anything decodes it. Null when unreadable. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** About a 7 000 × 7 000 photo: far above any model's input, far below a decompression bomb. */
export const MAX_PROMPT_IMAGE_PIXELS = 50_000_000;

const byte = (b: Uint8Array, at: number): number => b[at] ?? 0;
const u16be = (b: Uint8Array, at: number) => (byte(b, at) << 8) | byte(b, at + 1);
const u16le = (b: Uint8Array, at: number) => byte(b, at) | (byte(b, at + 1) << 8);
const u24le = (b: Uint8Array, at: number) => byte(b, at) | (byte(b, at + 1) << 8) | (byte(b, at + 2) << 16);
const u32be = (b: Uint8Array, at: number) =>
  ((byte(b, at) << 24) >>> 0) + ((byte(b, at + 1) << 16) | (byte(b, at + 2) << 8) | byte(b, at + 3));
const ascii = (b: Uint8Array, at: number, text: string) =>
  [...text].every((char, index) => b[at + index] === char.charCodeAt(0));

function png(b: Uint8Array): ImageSize | null {
  if (b.length < 24 || !ascii(b, 12, "IHDR")) return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

/** Start-of-frame markers: C0–CF except DHT (C4), JPG (C8) and DAC (CC). */
const isSof = (marker: number) =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function jpeg(b: Uint8Array): ImageSize | null {
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = byte(b, at + 1);
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2; // no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image, or scan data before any frame header
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (isSof(marker))
      return at + 9 <= b.length ? { width: u16be(b, at + 7), height: u16be(b, at + 5) } : null;
    at += 2 + length;
  }
  return null;
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 13) return null;
  let width = u16le(b, 6);
  let height = u16le(b, 8);
  const flags = byte(b, 10);
  let at = 13 + (flags & 0x80 ? 3 * 2 ** ((flags & 0x07) + 1) : 0);
  // A frame may declare more than the screen: take the first image descriptor's size too.
  while (at < b.length) {
    const block = byte(b, at);
    if (block === 0x2c) {
      if (at + 9 > b.length) return null;
      width = Math.max(width, u16le(b, at + 5));
      height = Math.max(height, u16le(b, at + 7));
      return { width, height };
    }
    if (block !== 0x21 || at + 2 > b.length) return null;
    at += 2; // extension introducer and label
    for (;;) {
      if (at >= b.length) return null;
      const size = byte(b, at);
      at += 1 + size;
      if (size === 0) break;
    }
  }
  return null;
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30) return null;
  if (ascii(b, 12, "VP8X")) return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  if (ascii(b, 12, "VP8L")) {
    if (b[20] !== 0x2f) return null;
    const bits = byte(b, 21) | (byte(b, 22) << 8) | (byte(b, 23) << 16) | (byte(b, 24) << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, "VP8 ")) {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

export function imageSize(bytes: Uint8Array, mimeType: string): ImageSize | null {
  const size =
    mimeType === "image/png"
      ? png(bytes)
      : mimeType === "image/jpeg"
        ? jpeg(bytes)
        : mimeType === "image/gif"
          ? gif(bytes)
          : mimeType === "image/webp"
            ? webp(bytes)
            : null;
  return size !== null && size.width > 0 && size.height > 0 ? size : null;
}

export const withinPixelBudget = (size: ImageSize | null): size is ImageSize =>
  size !== null && size.width * size.height <= MAX_PROMPT_IMAGE_PIXELS;
