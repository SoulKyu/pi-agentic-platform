import type { BinarySink, BinaryStream } from "@pap/contracts";

export interface SentFrame {
  readonly op: "output" | "reset" | "exit";
  readonly seq: number;
  readonly payload: Uint8Array;
}

/**
 * One binary stream as the ws server gives it: `send` is false until `commit()` (the answer went out), after
 * `close()`, and while `accepting` is false (the socket buffers over 1 MiB). `close()` runs the sink's `onClose`
 * once, like the real channel.
 */
export interface FakeStream {
  readonly stream: BinaryStream;
  readonly frames: SentFrame[];
  readonly closes: number;
  accepting: boolean;
  /** The RPC answer reached the client: `onOpen` runs. */
  commit(): void;
  input(seq: number, text: string | Uint8Array): void;
  ack(offset: number): void;
  /** The socket or the person closed the stream. */
  close(): void;
  /** Concatenation of the `output` payloads that were sent. */
  text(): string;
  /** `[op, seq]` of each frame. */
  shape(): Array<[string, number]>;
}

export function createFakeStream(streamId: number, sink: BinarySink): FakeStream {
  const frames: SentFrame[] = [];
  let state: "prepared" | "open" | "closed" = "prepared";
  let closes = 0;
  const fake: FakeStream = {
    frames,
    accepting: true,
    get closes() {
      return closes;
    },
    stream: {
      streamId,
      send(op, seq, payload) {
        if (state !== "open" || !fake.accepting) return false;
        frames.push({ op, seq, payload: new Uint8Array(payload) });
        return true;
      },
      close: () => fake.close(),
    },
    commit() {
      if (state !== "prepared") return;
      state = "open";
      sink.onOpen();
    },
    input(seq, text) {
      if (state === "open") sink.onInput(seq, typeof text === "string" ? Buffer.from(text) : text);
    },
    ack(offset) {
      if (state === "open") sink.onAck(offset);
    },
    close() {
      if (state === "closed") return;
      state = "closed";
      closes++;
      sink.onClose();
    },
    text: () => Buffer.concat(frames.filter((f) => f.op === "output").map((f) => f.payload)).toString("utf8"),
    shape: () => frames.map((f) => [f.op, f.seq]),
  };
  return fake;
}

/** A connection's channel: every `open` makes a `FakeStream`, kept in `streams`. */
export function createFakeConnection(): {
  readonly streams: FakeStream[];
  open(sink: BinarySink): BinaryStream;
  last(): FakeStream;
} {
  const streams: FakeStream[] = [];
  return {
    streams,
    open(sink) {
      const fake = createFakeStream(streams.length + 1, sink);
      streams.push(fake);
      return fake.stream;
    },
    last() {
      const fake = streams.at(-1);
      if (!fake) throw new Error("no stream was opened");
      return fake;
    },
  };
}
