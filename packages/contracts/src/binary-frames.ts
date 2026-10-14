/** Terminal bytes on /ws (spec C §4.2): a 16-byte header, then raw bytes. Layout after Orca's terminal stream protocol. */
export const FRAME_MAGIC = 0x70;
export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 16;
export const MAX_FRAME_PAYLOAD = 64 * 1024;
/** Keeps `high * 2^32 + low` a safe integer. */
const MAX_HIGH_WORD = 0x1f_ffff;
const TWO_32 = 0x1_0000_0000;

export const FRAME_OPS = { output: 1, reset: 2, exit: 3, input: 16, ack: 17 } as const;
export type FrameOp = (typeof FRAME_OPS)[keyof typeof FRAME_OPS];
/** What a client may receive, and what the server may receive. */
export const SERVER_OPS: ReadonlySet<number> = new Set([FRAME_OPS.output, FRAME_OPS.reset, FRAME_OPS.exit]);
export const CLIENT_OPS: ReadonlySet<number> = new Set([FRAME_OPS.input, FRAME_OPS.ack]);
const EMPTY_ONLY: ReadonlySet<number> = new Set([FRAME_OPS.reset, FRAME_OPS.ack]);

export interface BinaryFrame {
  readonly op: FrameOp;
  readonly streamId: number;
  readonly seq: number;
  readonly payload: Uint8Array;
}

export function encodeFrame(frame: BinaryFrame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 1 || frame.streamId > 0xffff_ffff)
    throw new RangeError("frame streamId out of range");
  if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) throw new RangeError("frame seq out of range");
  if (frame.payload.byteLength > MAX_FRAME_PAYLOAD) throw new RangeError("frame payload too large");
  if (EMPTY_ONLY.has(frame.op) && frame.payload.byteLength !== 0)
    throw new RangeError("frame carries no payload");
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, FRAME_MAGIC);
  view.setUint8(1, FRAME_VERSION);
  view.setUint8(2, frame.op);
  view.setUint8(3, 0);
  view.setUint32(4, frame.streamId, true);
  view.setUint32(8, Math.floor(frame.seq / TWO_32), true);
  view.setUint32(12, frame.seq % TWO_32, true);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

/** The frame, or null for anything that is not exactly a frame this side may receive. Never throws. */
export function decodeFrame(bytes: Uint8Array, accepted: ReadonlySet<number>): BinaryFrame | null {
  if (bytes.byteLength < FRAME_HEADER_BYTES || bytes.byteLength > FRAME_HEADER_BYTES + MAX_FRAME_PAYLOAD)
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== FRAME_MAGIC || view.getUint8(1) !== FRAME_VERSION || view.getUint8(3) !== 0)
    return null;
  const op = view.getUint8(2);
  if (!accepted.has(op)) return null;
  const streamId = view.getUint32(4, true);
  const high = view.getUint32(8, true);
  if (streamId === 0 || high > MAX_HIGH_WORD) return null;
  // A copy: the socket may reuse its buffer, and a Buffer's own `slice` is a view.
  const payload = new Uint8Array(bytes.subarray(FRAME_HEADER_BYTES));
  if (EMPTY_ONLY.has(op) && payload.byteLength !== 0) return null;
  return { op: op as FrameOp, streamId, seq: high * TWO_32 + view.getUint32(12, true), payload };
}
