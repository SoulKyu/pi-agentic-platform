import { describe, expect, it } from "vitest";
import { imageSize, MAX_PROMPT_IMAGE_PIXELS, withinPixelBudget } from "./image-size.ts";

const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n: number) => [(n >>> 8) & 255, n & 255];
const l16 = (n: number) => [n & 255, (n >>> 8) & 255];
const l24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const text = (s: string) => [...s].map((c) => c.charCodeAt(0));

function png(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0x89,
    ...text("PNG"),
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...u32(13),
    ...text("IHDR"),
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
  ]);
}
function jpeg(marker: number, width: number, height: number, before: number[] = []): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8,
    ...before,
    0xff,
    marker,
    ...u16(17),
    8,
    ...u16(height),
    ...u16(width),
    3,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]);
}
/** A real WebP is longer than its header: the reader wants 30 bytes. */
const padded = (bytes: Uint8Array) => Uint8Array.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0]);
const exif = [0xff, 0xe1, ...u16(10), ...text("Exif"), 0, 0, 0, 0];

describe("imageSize (M8R108)", () => {
  it("reads a PNG's IHDR", () => {
    expect(imageSize(png(1053, 745), "image/png")).toEqual({ width: 1053, height: 745 });
  });
  it("reads a baseline and a progressive JPEG after an EXIF segment", () => {
    expect(imageSize(jpeg(0xc0, 640, 480, exif), "image/jpeg")).toEqual({ width: 640, height: 480 });
    expect(imageSize(jpeg(0xc2, 3000, 2000, exif), "image/jpeg")).toEqual({ width: 3000, height: 2000 });
  });
  it("skips fill bytes before a marker", () => {
    expect(imageSize(jpeg(0xc0, 10, 20, [0xff, 0xff]), "image/jpeg")).toEqual({ width: 10, height: 20 });
  });
  it("answers null for a JPEG cut before its frame header", () => {
    expect(imageSize(Uint8Array.from([0xff, 0xd8, ...exif]), "image/jpeg")).toBeNull();
  });
  it("takes the larger of a GIF's screen and its first frame", () => {
    const gif = Uint8Array.from([
      ...text("GIF89a"),
      ...l16(1),
      ...l16(1),
      0,
      0,
      0,
      0x2c,
      ...l16(0),
      ...l16(0),
      ...l16(60000),
      ...l16(60000),
      0,
    ]);
    expect(imageSize(gif, "image/gif")).toEqual({ width: 60000, height: 60000 });
  });
  it("reads WebP VP8X, VP8L and VP8", () => {
    const head = (kind: string) => [...text("RIFF"), 0, 0, 0, 0, ...text("WEBP"), ...text(kind)];
    const vp8x = Uint8Array.from([
      ...head("VP8X"),
      10,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...l24(9999),
      ...l24(9999),
      0,
      0,
    ]);
    expect(imageSize(vp8x, "image/webp")).toEqual({ width: 10000, height: 10000 });
    const bits = (49 << 14) | 99;
    const vp8l = Uint8Array.from([
      ...head("VP8L"),
      0,
      0,
      0,
      0,
      0x2f,
      bits & 255,
      (bits >>> 8) & 255,
      (bits >>> 16) & 255,
      (bits >>> 24) & 255,
      0,
      0,
      0,
      0,
    ]);
    expect(imageSize(padded(vp8l), "image/webp")).toEqual({ width: 100, height: 50 });
    const vp8 = Uint8Array.from([
      ...head("VP8 "),
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0x9d,
      0x01,
      0x2a,
      ...l16(320),
      ...l16(240),
      0,
      0,
    ]);
    expect(imageSize(padded(vp8), "image/webp")).toEqual({ width: 320, height: 240 });
  });
  it("answers null for a type it does not know", () => {
    expect(imageSize(png(10, 10), "image/heic")).toBeNull();
  });
  it("judges the pixel budget at its edge", () => {
    expect(MAX_PROMPT_IMAGE_PIXELS).toBe(50_000_000);
    expect(withinPixelBudget({ width: 7000, height: 7000 })).toBe(true);
    expect(withinPixelBudget({ width: 7072, height: 7072 })).toBe(false);
    expect(withinPixelBudget(null)).toBe(false);
  });
  it("never throws on seeded random bytes of any length up to 64", () => {
    let seed = 12345;
    const next = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) & 255;
    for (const mime of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      for (let round = 0; round < 5000; round++) {
        const bytes = Uint8Array.from({ length: round % 65 }, next);
        expect(() => imageSize(bytes, mime)).not.toThrow();
      }
    }
  });
});
