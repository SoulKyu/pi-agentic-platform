import { MAX_FRAME_PAYLOAD } from "@pap/contracts";

/** Frames of at most `MAX_FRAME_PAYLOAD` bytes, each cut before a UTF-8 continuation byte (M8R112). */
export function splitUtf8(data: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  let at = 0;
  while (at < data.byteLength) {
    let end = Math.min(at + MAX_FRAME_PAYLOAD, data.byteLength);
    if (end < data.byteLength) {
      let cut = end;
      while (cut > at && ((data[cut] ?? 0) & 0xc0) === 0x80) cut--;
      // A run of continuation bytes with no lead byte is not UTF-8: cut at the cap rather than loop.
      if (cut > at) end = cut;
    }
    parts.push(data.subarray(at, end));
    at = end;
  }
  return parts;
}
