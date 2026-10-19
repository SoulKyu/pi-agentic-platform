import { describe, expect, it, vi } from "vitest";
import { AGENT_VM_MAX_FRAME_BYTES, HELLO_MAX_BYTES } from "./agents-vm.ts";
import { createFrameDecoder, encodeFrame, type FrameError } from "./socket-frames.ts";

// Mutants (RT-43), each run for real; the case that kills each is named:
// - bound checked after buffering the body (`if (size < need) return;` placed before the bound test): "refuses on the 4
//   header bytes alone".
// - `maxBytes()` read once at creation: "holds a 4096 bound ... raises the bound".
// - `maxBytes()` read once per push instead of per header: "reads the bound at each header, even inside one chunk".
// - NaN bound accepted (`length > bound` refuses, NaN passes): "refuses when the bound is NaN".
// - a throwing `maxBytes()` leaves the decoder advanced (no try/catch): "fails closed when maxBytes throws".
// - body decoded with lossy `toString("utf8")`: "reports invalid UTF-8 as bad_json".
// - `if (failed) return` removed from `push` (with `for (;;)` the loop then delivers): "reports invalid JSON once and stops".
// - `close` setting the flag without clearing `parts`/`size` (the rest of the chunk is still decoded after `stop()` in
//   `onFrame`): "stop() inside onFrame delivers exactly one frame ...". `stop()` a no-op: that case and "delivers nothing
//   after stop()". (A check after `onFrame` is redundant: `close` empties the buffer, so the loop ends; no mutant.)
// - encode bounded by the WebSocket 1 MiB MAX_FRAME_BYTES, or by string length instead of bytes: "encodes a body of exactly
//   4 MiB ..." and "bounds the encoded bytes, not the characters".
// - `take` always concatenating (CPU amplification): "decodes 13000 tiny frames of one chunk with no Buffer.concat" and the
//   4 MiB test (exactly one concat).

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
  it("bounds the encoded bytes, not the characters", () => {
    expect(() => encodeFrame("\u00e9".repeat(AGENT_VM_MAX_FRAME_BYTES / 2))).toThrow(RangeError);
  });

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

  it("decodes a 4 MiB frame in 64 KiB chunks with exactly one Buffer.concat call", () => {
    const { decoder, frames, errors } = collect(() => AGENT_VM_MAX_FRAME_BYTES);
    const value = "q".repeat(AGENT_VM_MAX_FRAME_BYTES - 2);
    const bytes = encodeFrame(value);
    expect(bytes.length).toBe(4 + AGENT_VM_MAX_FRAME_BYTES);
    const spy = vi.spyOn(Buffer, "concat");
    try {
      for (let i = 0; i < bytes.length; i += 65536) decoder.push(bytes.subarray(i, i + 65536));
      expect(spy.mock.calls.length).toBe(1);
    } finally {
      spy.mockRestore();
    }
    expect(frames).toEqual([value]);
    expect(errors).toEqual([]);
  });

  it("decodes 13000 tiny frames of one chunk with no Buffer.concat", () => {
    const { decoder, frames } = collect(() => 1024);
    const chunk = Buffer.concat(Array.from({ length: 13_000 }, (_, i) => encodeFrame(i)));
    const spy = vi.spyOn(Buffer, "concat");
    try {
      decoder.push(chunk);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
    expect(frames.length).toBe(13_000);
    expect(frames[12_999]).toBe(12_999);
  });

  it("reads the bound at each header, even inside one chunk", () => {
    const limit = { value: HELLO_MAX_BYTES };
    const frames: unknown[] = [];
    const errors: FrameError[] = [];
    const decoder = createFrameDecoder({
      maxBytes: () => limit.value,
      onFrame: (value) => {
        frames.push(value);
        limit.value = AGENT_VM_MAX_FRAME_BYTES;
      },
      onError: (error) => errors.push(error),
    });
    const big = { data: "b".repeat(10_000) };
    decoder.push(Buffer.concat([encodeFrame({ type: "hello" }), encodeFrame(big)]));
    expect(frames).toEqual([{ type: "hello" }, big]);
    expect(errors).toEqual([]);
  });

  it("refuses when the bound is NaN", () => {
    const { decoder, frames, errors } = collect(() => Number.NaN);
    decoder.push(encodeFrame("x"));
    expect(errors).toEqual(["too_large"]);
    expect(frames).toEqual([]);
  });

  it("fails closed when maxBytes throws", () => {
    const { decoder, frames, errors } = collect(() => {
      throw new Error("bound unavailable");
    });
    decoder.push(encodeFrame("x"));
    decoder.push(encodeFrame("y"));
    expect(errors).toEqual(["too_large"]);
    expect(frames).toEqual([]);
  });

  it("reports invalid UTF-8 as bad_json", () => {
    const { decoder, frames, errors } = collect(() => 1024);
    const body = Buffer.from([0x22, 0xff, 0x22]);
    decoder.push(Buffer.concat([header(body.length), body]));
    expect(errors).toEqual(["bad_json"]);
    expect(frames).toEqual([]);
  });

  it("stop() inside onFrame delivers exactly one frame of a 1000-frame chunk", () => {
    const frames: unknown[] = [];
    const holder: { decoder?: ReturnType<typeof createFrameDecoder> } = {};
    holder.decoder = createFrameDecoder({
      maxBytes: () => 1024,
      onFrame: (value) => {
        frames.push(value);
        holder.decoder?.stop();
      },
      onError: () => undefined,
    });
    holder.decoder.push(Buffer.concat(Array.from({ length: 1000 }, (_, i) => encodeFrame(i))));
    holder.decoder.push(encodeFrame("later"));
    expect(frames).toEqual([0]);
  });

  it("delivers nothing after stop()", () => {
    const { decoder, frames, errors } = collect(() => 1024);
    const half = encodeFrame("whole");
    decoder.push(half.subarray(0, 6));
    decoder.stop();
    decoder.push(half.subarray(6));
    decoder.push(encodeFrame("next"));
    expect(frames).toEqual([]);
    expect(errors).toEqual([]);
  });
});
