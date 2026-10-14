import { FILE_LIMITS, type ImageMime } from "@pap/contracts";

const startsWith = (head: Uint8Array, bytes: readonly number[], at = 0) =>
  bytes.every((byte, index) => head[at + index] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** M8R38: the type an image really has, from its first 12 bytes; null for anything else. */
export function sniffImage(head: Uint8Array, size: number): ImageMime | null {
  if (size > FILE_LIMITS.imageBytes) return null;
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(head, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(head, ascii("GIF87a")) || startsWith(head, ascii("GIF89a"))) return "image/gif";
  if (startsWith(head, ascii("RIFF")) && startsWith(head, ascii("WEBP"), 8)) return "image/webp";
  return null;
}
