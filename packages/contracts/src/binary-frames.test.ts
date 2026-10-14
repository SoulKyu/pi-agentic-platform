import { describe, expect, it } from "vitest";
import {
  CLIENT_OPS,
  decodeFrame,
  encodeFrame,
  FRAME_HEADER_BYTES,
  FRAME_OPS,
  MAX_FRAME_PAYLOAD,
  SERVER_OPS,
  type BinaryFrame,
} from "./binary-frames.ts";

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

function header(overrides: Record<number, number> = {}, payload = 0): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_BYTES + payload);
  out.set([0x70, 1, FRAME_OPS.output, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  for (const [at, value] of Object.entries(overrides)) out[Number(at)] = value;
  return out;
}

describe("binary frame codec", () => {
  const cases: Array<[string, BinaryFrame["op"], ReadonlySet<number>, Uint8Array]> = [
    ["output", FRAME_OPS.output, SERVER_OPS, bytes(1, 2, 3)],
    ["reset", FRAME_OPS.reset, SERVER_OPS, bytes()],
    ["exit", FRAME_OPS.exit, SERVER_OPS, bytes(0, 0, 0, 1)],
    ["input", FRAME_OPS.input, CLIENT_OPS, bytes(0x61)],
    ["ack", FRAME_OPS.ack, CLIENT_OPS, bytes()],
  ];

  it.each(cases)("round-trips %s at the seq edges", (_name, op, accepted, payload) => {
    for (const seq of [0, 2 ** 32, Number.MAX_SAFE_INTEGER]) {
      const frame = { op, streamId: 7, seq, payload };
      expect(decodeFrame(encodeFrame(frame), accepted)).toEqual(frame);
    }
  });

  it("writes the documented header", () => {
    const out = encodeFrame({
      op: FRAME_OPS.output,
      streamId: 0x01020304,
      seq: 2 ** 32 + 5,
      payload: bytes(9),
    });
    expect([...out]).toEqual([0x70, 1, 1, 0, 4, 3, 2, 1, 1, 0, 0, 0, 5, 0, 0, 0, 9]);
  });

  it("refuses to encode what the decoder would refuse", () => {
    const base = { op: FRAME_OPS.output, streamId: 1, seq: 0, payload: bytes() } as const;
    expect(() => encodeFrame({ ...base, streamId: 0 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, streamId: 2 ** 32 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, seq: -1 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, seq: 2 ** 53 })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, payload: new Uint8Array(MAX_FRAME_PAYLOAD + 1) })).toThrow(
      RangeError,
    );
    expect(() => encodeFrame({ ...base, op: FRAME_OPS.reset, payload: bytes(1) })).toThrow(RangeError);
    expect(() => encodeFrame({ ...base, op: FRAME_OPS.ack, payload: bytes(1) })).toThrow(RangeError);
  });

  it("accepts a full 64 KiB payload", () => {
    const payload = new Uint8Array(MAX_FRAME_PAYLOAD).fill(7);
    const frame = { op: FRAME_OPS.output, streamId: 1, seq: 1, payload };
    expect(decodeFrame(encodeFrame(frame), SERVER_OPS)?.payload.byteLength).toBe(MAX_FRAME_PAYLOAD);
  });

  it.each([
    ["15 bytes", new Uint8Array(15)],
    ["a wrong magic", header({ 0: 0x71 })],
    ["version 2", header({ 1: 2 })],
    ["flags 1", header({ 3: 1 })],
    ["an unknown op", header({ 2: 4 })],
    ["stream id 0", header({ 4: 0 })],
    ["a high word of 0x200000", header({ 10: 0x20 })],
    ["a payload over 64 KiB", header({}, MAX_FRAME_PAYLOAD + 1)],
    ["an ack with a payload byte", header({ 2: FRAME_OPS.ack }, 1)],
    ["a reset with a payload byte", header({ 2: FRAME_OPS.reset }, 1)],
  ])("decodes %s to null", (_name, input) => {
    expect(decodeFrame(input, new Set([...SERVER_OPS, ...CLIENT_OPS]))).toBeNull();
  });

  it("accepts a high word of 0x1FFFFF and nothing above", () => {
    const edge = header({ 10: 0x1f, 9: 0xff, 8: 0xff });
    expect(decodeFrame(edge, SERVER_OPS)?.seq).toBe(0x1f_ffff * 2 ** 32);
  });

  it("refuses an op that goes the other way", () => {
    expect(decodeFrame(header(), CLIENT_OPS)).toBeNull();
    expect(decodeFrame(header({ 2: FRAME_OPS.input }), SERVER_OPS)).toBeNull();
  });

  it("returns a payload that does not alias the source buffer", () => {
    const source = header({}, 2);
    source.set([5, 6], FRAME_HEADER_BYTES);
    const frame = decodeFrame(source, SERVER_OPS);
    source.fill(0, FRAME_HEADER_BYTES);
    expect([...(frame?.payload ?? [])]).toEqual([5, 6]);
  });

  it("decodes a view into a larger buffer", () => {
    const frame = encodeFrame({ op: FRAME_OPS.input, streamId: 3, seq: 4, payload: bytes(1) });
    const big = new Uint8Array(40);
    big.set(frame, 11);
    expect(decodeFrame(big.subarray(11, 11 + frame.byteLength), CLIENT_OPS)).toMatchObject({
      streamId: 3,
      seq: 4,
    });
  });
});
