import { describe, expect, it, vi } from "vitest";
import { AGENT_VM_MAX_FRAME_BYTES, HELLO_MAX_BYTES } from "./agents-vm.ts";
import { createFrameDecoder, encodeFrame, type FrameError } from "./socket-frames.ts";

// Mutants (RT-43), each run for real:
// - bound checked after buffering the body (`if (size < need) return;` placed before the `need > maxBytes()` test):
//   killed by "refuses on the 4 header bytes alone" (no body is ever sent, so nothing would fail).
// - `maxBytes()` read once at creation instead of at each header: killed by "raises the bound after the first frame".
// - both failure guards removed (`if (failed) return` in `push` and `while (!failed)`): killed by "reports invalid JSON once
//   and stops" (a later valid frame would be delivered). Either guard alone is enough for delivery (run for real: each
//   removed alone passes all 11 tests), so they are redundant by design; the first also stops buffering after a failure.
// - encodeFrame bounded by the WebSocket 1 MiB MAX_FRAME_BYTES: killed by "encodes a body of exactly 4 MiB".

function collect(maxBytes: () => number) {
  const frames: unknown[] = [];
  const errors: FrameError[] = [];
  const decoder = createFrameDecoder({
    maxBytes,
    onFrame: (value) => frames.push(value),
    onError: (error) => errors.push(error),
  });
  return { decoder, frames, errors };
}

function header(length: number): Buffer {
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(length, 0);
  return head;
}

describe("encodeFrame", () => {
  it("prefixes the JSON body with its big-endian length", () => {
    const frame = encodeFrame({ a: 1 });
    expect(frame.readUInt32BE(0)).toBe(7);
    expect(frame.subarray(4).toString("utf8")).toBe('{"a":1}');
  });

  it("encodes a body of exactly 4 MiB and throws one byte more", () => {
    expect(AGENT_VM_MAX_FRAME_BYTES).toBe(4 * 1024 * 1024);
    const overhead = JSON.stringify("").length;
    const exact = "x".repeat(AGENT_VM_MAX_FRAME_BYTES - overhead);
    expect(encodeFrame(exact).length).toBe(4 + AGENT_VM_MAX_FRAME_BYTES);
    expect(() => encodeFrame(`${exact}x`)).toThrow(RangeError);
  });
});

describe("createFrameDecoder", () => {
  it("decodes a frame split across 1-byte chunks once", () => {
    const { decoder, frames, errors } = collect(() => 1024);
    const bytes = encodeFrame({ hello: "wörld" });
    for (let i = 0; i < bytes.length; i++) decoder.push(bytes.subarray(i, i + 1));
    expect(frames).toEqual([{ hello: "wörld" }]);
    expect(errors).toEqual([]);
  });

  it("decodes three frames in one chunk in order", () => {
    const { decoder, frames } = collect(() => 1024);
    decoder.push(Buffer.concat([encodeFrame(1), encodeFrame("two"), encodeFrame({ three: 3 })]));
    expect(frames).toEqual([1, "two", { three: 3 }]);
  });

  it("refuses on the 4 header bytes alone, and delivers nothing after an error", () => {
    const { decoder, frames, errors } = collect(() => 4096);
    decoder.push(header(4097));
    expect(errors).toEqual(["too_large"]);
    decoder.push(encodeFrame("valid"));
    decoder.push(encodeFrame("valid again"));
    expect(frames).toEqual([]);
    expect(errors).toEqual(["too_large"]);
  });

  it("accepts a header at exactly the bound", () => {
    const { decoder, frames, errors } = collect(() => 9);
    decoder.push(encodeFrame("1234567"));
    expect(frames).toEqual(["1234567"]);
    expect(errors).toEqual([]);
  });

  it("holds a 4096 bound for a 5000-byte hello, and raises the bound after the first frame", () => {
    const limit = { value: HELLO_MAX_BYTES };
    const { decoder, frames, errors } = collect(() => limit.value);
    decoder.push(encodeFrame({ type: "hello" }));
    limit.value = AGENT_VM_MAX_FRAME_BYTES;
    const big = { data: "y".repeat(100_000) };
    decoder.push(encodeFrame(big));
    expect(frames).toEqual([{ type: "hello" }, big]);
    expect(errors).toEqual([]);

    const strict = collect(() => HELLO_MAX_BYTES);
    strict.decoder.push(encodeFrame({ data: "z".repeat(5000) }));
    expect(strict.errors).toEqual(["too_large"]);
    expect(strict.frames).toEqual([]);
  });

  it("reports invalid JSON once and stops", () => {
    const { decoder, frames, errors } = collect(() => 1024);
    const bad = Buffer.from("{nope", "utf8");
    decoder.push(Buffer.concat([header(bad.length), bad, encodeFrame("after")]));
    decoder.push(encodeFrame("later"));
    expect(errors).toEqual(["bad_json"]);
    expect(frames).toEqual([]);
  });

  it("reports a zero-length frame as bad_json once and stops", () => {
    const { decoder, frames, errors } = collect(() => 1024);
    decoder.push(Buffer.concat([header(0), encodeFrame("after")]));
    expect(errors).toEqual(["bad_json"]);
    expect(frames).toEqual([]);
  });

  it("keeps the frames delivered before an error", () => {
    const { decoder, frames, errors } = collect(() => 64);
    decoder.push(Buffer.concat([encodeFrame("ok"), header(65)]));
    expect(frames).toEqual(["ok"]);
    expect(errors).toEqual(["too_large"]);
  });

  it("decodes a 4 MiB frame in 64 KiB chunks with at most two Buffer.concat calls", () => {
    const { decoder, frames, errors } = collect(() => AGENT_VM_MAX_FRAME_BYTES);
    const value = "q".repeat(AGENT_VM_MAX_FRAME_BYTES - 2);
    const bytes = encodeFrame(value);
    expect(bytes.length).toBe(4 + AGENT_VM_MAX_FRAME_BYTES);
    const spy = vi.spyOn(Buffer, "concat");
    try {
      for (let i = 0; i < bytes.length; i += 65536) decoder.push(bytes.subarray(i, i + 65536));
      expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }
    expect(frames).toEqual([value]);
    expect(errors).toEqual([]);
  });
});
