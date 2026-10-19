import { AGENT_VM_MAX_FRAME_BYTES } from "./agents-vm.ts";

export function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > AGENT_VM_MAX_FRAME_BYTES) throw new RangeError("frame too large");
  const head = Buffer.allocUnsafe(4);
  head.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, body]);
}

export type FrameError = "too_large" | "bad_json";
export interface FrameDecoder {
  push(chunk: Buffer): void;
}

/**
 * Length-prefixed JSON frames. A declared length over `maxBytes()` fails on the header, before any body byte is kept (the
 * receive-side bound Node's IPC never had, R101). `maxBytes` is read at each header, so the gateway can hold a connection to
 * HELLO_MAX_BYTES until its hello is accepted (RT-27). After a failure nothing more is delivered; the caller closes the socket.
 */
export function createFrameDecoder(options: {
  maxBytes(): number;
  onFrame(value: unknown): void;
  onError(error: FrameError): void;
}): FrameDecoder {
  let parts: Buffer[] = [];
  let size = 0;
  let need = -1;
  let failed = false;
  const fail = (error: FrameError): void => {
    failed = true;
    parts = [];
    size = 0;
    options.onError(error);
  };
  const take = (count: number): Buffer => {
    const all = parts.length === 1 ? (parts[0] as Buffer) : Buffer.concat(parts, size);
    const rest = all.subarray(count);
    parts = rest.length > 0 ? [rest] : [];
    size = rest.length;
    return all.subarray(0, count);
  };
  return {
    push(chunk) {
      if (failed) return;
      parts.push(chunk);
      size += chunk.length;
      while (!failed) {
        if (need < 0) {
          if (size < 4) return;
          need = take(4).readUInt32BE(0);
          if (need > options.maxBytes()) return fail("too_large");
        }
        if (size < need) return;
        const body = take(need);
        need = -1;
        let value: unknown;
        try {
          value = JSON.parse(body.toString("utf8"));
        } catch {
          return fail("bad_json");
        }
        options.onFrame(value);
      }
    },
  };
}
