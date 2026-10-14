import {
  CLIENT_OPS,
  decodeFrame,
  encodeFrame,
  FRAME_OPS,
  PapError,
  type BinarySink,
  type BinaryStream,
} from "@pap/contracts";
import type { Logger } from "../logger.ts";

/** Streams one connection may hold, prepared or open; the next `open` throws `capacity` (M8R9). */
export const MAX_BINARY_STREAMS = 16;
/** Above this many buffered bytes `send` answers false: the stream pauses, the socket lives (M8R12). */
export const STREAM_BUFFER_LIMIT = 1024 * 1024;

export interface BinaryStreamsDeps {
  readonly connectionId: string;
  send(bytes: Uint8Array): void;
  /** Bytes the socket still holds; `Infinity` when it cannot take any. */
  buffered(): number;
  readonly logger: Logger;
}

export interface PreparedStream {
  readonly stream: BinaryStream;
  /** After the answer that names the stream went out: runs `onOpen`. A no-op once the stream is closed. */
  commit(): void;
  /** The request failed: closes the stream (`onClose`). A no-op once it is closed. */
  release(): void;
}

export interface BinaryStreams {
  open(sink: BinarySink): PreparedStream;
  /** One inbound binary message. Never throws: anything unusable is dropped and counted (M8R8). */
  onFrame(data: Uint8Array): void;
  closeAll(): void;
}

type DropReason = "malformed" | "unknown_stream";
type State = "prepared" | "open" | "closed";
interface Entry {
  readonly sink: BinarySink;
  state: State;
}

export function createBinaryStreams(deps: BinaryStreamsDeps): BinaryStreams {
  const live = new Map<number, Entry>();
  let nextId = 0;
  let dropped = 0;

  const drop = (reason: DropReason): void => {
    dropped++;
    // Counts 1, 2, 4, 8…: a broken client cannot flood the log. Only the connection and the reason are logged.
    if ((dropped & (dropped - 1)) === 0)
      deps.logger.warn("ws_binary_dropped", { connectionId: deps.connectionId, reason, count: dropped });
  };

  const guarded = (streamId: number, call: () => void): void => {
    try {
      call();
    } catch (error) {
      deps.logger.error("ws_binary_sink_failed", { connectionId: deps.connectionId, streamId, err: error });
    }
  };

  const close = (streamId: number): void => {
    const entry = live.get(streamId);
    if (!entry || entry.state === "closed") return;
    entry.state = "closed";
    live.delete(streamId);
    guarded(streamId, () => entry.sink.onClose());
  };

  return {
    open(sink) {
      if (live.size >= MAX_BINARY_STREAMS) throw new PapError("capacity");
      const streamId = ++nextId;
      const entry: Entry = { sink, state: "prepared" };
      live.set(streamId, entry);
      const stream: BinaryStream = {
        streamId,
        send(op, seq, payload) {
          if (entry.state !== "open" || deps.buffered() > STREAM_BUFFER_LIMIT) return false;
          deps.send(encodeFrame({ op: FRAME_OPS[op], streamId, seq, payload }));
          return true;
        },
        close: () => close(streamId),
      };
      return {
        stream,
        commit() {
          if (entry.state !== "prepared") return;
          entry.state = "open";
          try {
            entry.sink.onOpen();
          } catch (error) {
            deps.logger.error("ws_binary_sink_failed", {
              connectionId: deps.connectionId,
              streamId,
              err: error,
            });
            close(streamId);
          }
        },
        release: () => close(streamId),
      };
    },
    onFrame(data) {
      const frame = decodeFrame(data, CLIENT_OPS);
      if (!frame) return drop("malformed");
      const entry = live.get(frame.streamId);
      if (entry?.state !== "open") return drop("unknown_stream");
      try {
        if (frame.op === FRAME_OPS.input) entry.sink.onInput(frame.seq, frame.payload);
        else entry.sink.onAck(frame.seq);
      } catch (error) {
        deps.logger.error("ws_binary_sink_failed", {
          connectionId: deps.connectionId,
          streamId: frame.streamId,
          err: error,
        });
        close(frame.streamId);
      }
    },
    closeAll() {
      for (const streamId of [...live.keys()]) close(streamId);
    },
  };
}
