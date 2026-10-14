import { describe, expect, it } from "vitest";
import { CLIENT_OPS, decodeFrame, encodeFrame, FRAME_OPS, SERVER_OPS } from "./binary-frames.ts";

function xorshift(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state;
  };
}

describe("binary frame decoder against hostile bytes", () => {
  it("never throws, and everything it accepts re-encodes to the same bytes", () => {
    const next = xorshift(0x9e3779b9);
    const accepted = new Set([...SERVER_OPS, ...CLIENT_OPS]);
    let decoded = 0;
    for (let round = 0; round < 10_000; round++) {
      const input = new Uint8Array(next() % 81);
      for (let i = 0; i < input.length; i++) input[i] = next() & 0xff;
      if (round % 2 === 0 && input.length >= 4) {
        input[0] = 0x70;
        input[1] = 1;
        input[3] = 0;
        if (round % 4 === 0) input[2] = [1, 2, 3, 16, 17][next() % 5] ?? 1;
        if (round % 8 === 0 && input.length >= 16) {
          input[11] = 0;
          input[10] = (input[10] ?? 0) & 0x1f;
        }
      }
      const frame = decodeFrame(input, accepted);
      if (!frame) continue;
      decoded++;
      expect([...encodeFrame(frame)]).toEqual([...input]);
      expect(Object.values(FRAME_OPS)).toContain(frame.op);
    }
    expect(decoded).toBe(592);
  });
});
