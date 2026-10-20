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
  /** Nothing is delivered or buffered afterwards, not even the rest of the current chunk (safe to call from `onFrame`). */
  stop(): void;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Length-prefixed JSON frames. A declared length over `maxBytes()` fails on the header, before any body byte is kept (the
 * receive-side bound Node's IPC never had, R101). `maxBytes` is read at each header, so the gateway can hold a connection to
 * HELLO_MAX_BYTES until its hello is accepted (RT-27); a bound that is NaN or throws refuses the frame. After a failure or
 * `stop()` nothing more is delivered or buffered; the caller closes the socket. Invalid UTF-8 is `bad_json`, never replaced.
 */
export function createFrameDecoder(options: {
  maxBytes(): number;
  onFrame(value: unknown): void;
  onError(error: FrameError): void;
}): FrameDecoder {
  let parts: Buffer[] = [];
  let size = 0;
  let need = -1;
  let closed = false;
  const close = (): void => {
    closed = true;
    parts = [];
    size = 0;
  };
  const fail = (error: FrameError): void => {
    close();
    options.onError(error);
  };
  const withinBound = (length: number): boolean => {
    try {
      return length <= options.maxBytes();
    } catch {
      return false;
    }
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
      if (closed) return;
      parts.push(chunk);
      size += chunk.length;
      for (;;) {
        if (need < 0) {
          if (size < 4) return;
          const length = take(4).readUInt32BE(0);
          if (!withinBound(length)) return fail("too_large");
          need = length;
        }
        if (size < need) return;
        const body = take(need);
        need = -1;
        let value: unknown;
        try {
          value = JSON.parse(utf8.decode(body));
        } catch {
          return fail("bad_json");
        }
        options.onFrame(value);
      }
    },
    stop: close,
  };
}
