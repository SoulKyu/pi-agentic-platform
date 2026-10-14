import { FILE_LIMITS } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { sniffImage } from "./sniff.ts";

const head = (bytes: readonly number[]): Uint8Array => Uint8Array.from([...bytes, ...new Array(12).fill(0)]);
const ascii = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));

describe("sniffImage (M8R38)", () => {
  it("names each signature", () => {
    expect(sniffImage(head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 100)).toBe("image/png");
    expect(sniffImage(head([0xff, 0xd8, 0xff, 0xe0]), 100)).toBe("image/jpeg");
    expect(sniffImage(head(ascii("GIF87a")), 100)).toBe("image/gif");
    expect(sniffImage(head(ascii("GIF89a")), 100)).toBe("image/gif");
    expect(sniffImage(head([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WEBP")]), 100)).toBe("image/webp");
  });

  it("reads the bytes only: a RIFF without WEBP, HEIC, text and short heads are files", () => {
    expect(sniffImage(head([...ascii("RIFF"), 1, 2, 3, 4, ...ascii("WAVE")]), 100)).toBeNull();
    expect(sniffImage(head([0, 0, 0, 0x18, ...ascii("ftypheic")]), 100)).toBeNull();
    expect(sniffImage(head(ascii("%PDF-1.7")), 100)).toBeNull();
    expect(sniffImage(Uint8Array.from([0x89, 0x50]), 2)).toBeNull();
    expect(sniffImage(new Uint8Array(0), 0)).toBeNull();
  });

  it("refuses an image above 10 MiB and accepts exactly 10 MiB", () => {
    const png = head([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(sniffImage(png, FILE_LIMITS.imageBytes)).toBe("image/png");
    expect(sniffImage(png, FILE_LIMITS.imageBytes + 1)).toBeNull();
  });
});
