import { encodeFrame, FRAME_OPS, MAX_FRAME_PAYLOAD, PapError, type BinarySink } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createBinaryStreams, MAX_BINARY_STREAMS, STREAM_BUFFER_LIMIT } from "./binary-streams.ts";

interface Recorded extends BinarySink {
  readonly events: string[];
}

function recorder(overrides: Partial<BinarySink> = {}): Recorded {
  const events: string[] = [];
  return {
    events,
    onOpen: () => void events.push("open"),
    onInput: (seq, payload) => void events.push(`input:${seq}:${new TextDecoder().decode(payload)}`),
    onAck: (seq) => void events.push(`ack:${seq}`),
    onClose: () => void events.push("close"),
    ...overrides,
  };
}

function setup() {
  const sent: Uint8Array[] = [];
  let buffered = 0;
  const { logger, lines } = captureLogger();
  const streams = createBinaryStreams({
    connectionId: "c1",
    send: (bytes) => void sent.push(bytes),
    buffered: () => buffered,
    logger,
  });
  const dropLogs = () => lines.filter((line) => line.msg === "ws_binary_dropped");
  return { streams, sent, lines, dropLogs, setBuffered: (value: number) => (buffered = value) };
}

const inputFrame = (streamId: number, seq: number, text = ""): Uint8Array =>
  encodeFrame({ op: FRAME_OPS.input, streamId, seq, payload: new TextEncoder().encode(text) });

function openCommitted(streams: ReturnType<typeof setup>["streams"], sink: BinarySink = recorder()) {
  const opened = streams.open(sink);
  opened.commit();
  return opened;
}

describe("binary streams", () => {
  it("allows 16 streams, refuses the 17th with capacity, and never reuses an id", () => {
    const { streams } = setup();
    const opened = Array.from({ length: MAX_BINARY_STREAMS }, () => streams.open(recorder()));
    expect(opened.map(({ stream }) => stream.streamId)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(() => streams.open(recorder())).toThrow(PapError);
    expect(() => streams.open(recorder())).toThrow(expect.objectContaining({ code: "capacity" }));
    for (const { stream } of opened.slice(0, 3)) stream.close();
    expect(streams.open(recorder()).stream.streamId).toBe(17);
  });

  it("holds sends back until the commit, then runs onOpen and lets frames flow", () => {
    const { streams, sent } = setup();
    const sink = recorder();
    const { stream, commit } = streams.open(sink);
    expect(stream.send("output", 0, Uint8Array.of(1))).toBe(false);
    expect(sink.events).toEqual([]);
    commit();
    expect(sink.events).toEqual(["open"]);
    expect(stream.send("output", 0, Uint8Array.of(1))).toBe(true);
    expect(sent).toHaveLength(1);
    commit();
    expect(sink.events).toEqual(["open"]);
  });

  it("release runs onClose once and onOpen never", () => {
    const { streams } = setup();
    const sink = recorder();
    const { release, commit } = streams.open(sink);
    release();
    release();
    commit();
    expect(sink.events).toEqual(["close"]);
  });

  it("a prepared stream closed through stream.close() is gone: commit runs no onOpen (RT-30)", () => {
    const { streams } = setup();
    const sink = recorder();
    const { stream, commit, release } = streams.open(sink);
    stream.close();
    commit();
    release();
    expect(sink.events).toEqual(["close"]);
  });

  it("routes input and ack to the stream they name", () => {
    const { streams } = setup();
    const first = recorder();
    const second = recorder();
    openCommitted(streams, first);
    const { stream } = openCommitted(streams, second);
    streams.onFrame(inputFrame(stream.streamId, 5, "ls"));
    streams.onFrame(
      encodeFrame({ op: FRAME_OPS.ack, streamId: stream.streamId, seq: 9, payload: new Uint8Array() }),
    );
    expect(second.events).toEqual(["open", "input:5:ls", "ack:9"]);
    expect(first.events).toEqual(["open"]);
  });

  it("drops what it cannot use and logs at counts 1, 2 and 4 only", () => {
    const { streams, dropLogs } = setup();
    const sink = recorder();
    openCommitted(streams, sink);
    streams.onFrame(inputFrame(99, 0, "secret-payload"));
    streams.onFrame(encodeFrame({ op: FRAME_OPS.output, streamId: 1, seq: 0, payload: new Uint8Array() }));
    streams.onFrame(new Uint8Array(3));
    streams.onFrame(inputFrame(98, 0));
    expect(sink.events).toEqual(["open"]);
    expect(dropLogs().map(({ count, reason, connectionId }) => ({ count, reason, connectionId }))).toEqual([
      { count: 1, reason: "unknown_stream", connectionId: "c1" },
      { count: 2, reason: "malformed", connectionId: "c1" },
      { count: 4, reason: "unknown_stream", connectionId: "c1" },
    ]);
    expect(Object.keys(dropLogs()[0] ?? {}).sort()).toEqual(
      ["connectionId", "count", "level", "msg", "reason", "time"].sort(),
    );
    expect(JSON.stringify(dropLogs())).not.toContain("secret-payload");
  });

  it("drops input for a stream that is prepared or closed, as unknown_stream", () => {
    const { streams, dropLogs } = setup();
    const sink = recorder();
    const { stream } = streams.open(sink);
    streams.onFrame(inputFrame(stream.streamId, 0, "x"));
    stream.close();
    streams.onFrame(inputFrame(stream.streamId, 0, "x"));
    expect(sink.events).toEqual(["close"]);
    expect(dropLogs().map((line) => [line.count, line.reason])).toEqual([
      [1, "unknown_stream"],
      [2, "unknown_stream"],
    ]);
  });

  it("drops an oversized frame aimed at an open stream, as malformed", () => {
    const { streams, dropLogs } = setup();
    const sink = recorder();
    const { stream } = openCommitted(streams, sink);
    const big = inputFrame(stream.streamId, 0);
    streams.onFrame(new Uint8Array([...big, ...new Uint8Array(MAX_FRAME_PAYLOAD + 1)]));
    streams.onFrame(inputFrame(stream.streamId, 1, "ok"));
    expect(sink.events).toEqual(["open", "input:1:ok"]);
    expect(dropLogs().map((line) => [line.count, line.reason])).toEqual([[1, "malformed"]]);
  });

  it("closes only the stream whose sink throws", () => {
    const { streams, lines } = setup();
    const bad = recorder({
      onInput: () => {
        throw new Error("boom");
      },
    });
    const good = recorder();
    const badOpened = openCommitted(streams, bad);
    openCommitted(streams, good);
    streams.onFrame(inputFrame(badOpened.stream.streamId, 0, "x"));
    expect(bad.events).toEqual(["open", "close"]);
    expect(good.events).toEqual(["open"]);
    expect(badOpened.stream.send("output", 0, Uint8Array.of(1))).toBe(false);
    expect(lines.some((line) => line.msg === "ws_binary_sink_failed")).toBe(true);
  });

  it("closes a stream whose onOpen throws, and the others stay", () => {
    const { streams } = setup();
    const bad = recorder({
      onOpen: () => {
        throw new Error("boom");
      },
    });
    const good = recorder();
    streams.open(bad).commit();
    openCommitted(streams, good);
    expect(bad.events).toEqual(["close"]);
    expect(good.events).toEqual(["open"]);
  });

  it("closeAll runs every onClose once, prepared streams included", () => {
    const { streams } = setup();
    const sinks = [recorder(), recorder(), recorder()];
    openCommitted(streams, sinks[0]);
    openCommitted(streams, sinks[1]);
    streams.open(sinks[2] as BinarySink);
    streams.closeAll();
    streams.closeAll();
    expect(sinks.map((sink) => sink.events)).toEqual([["open", "close"], ["open", "close"], ["close"]]);
  });

  it("send is false while the socket buffers more than 1 MiB, and the stream stays open", () => {
    const { streams, sent, setBuffered } = setup();
    const sink = recorder();
    const { stream } = openCommitted(streams, sink);
    setBuffered(STREAM_BUFFER_LIMIT + 1);
    expect(stream.send("output", 0, Uint8Array.of(1))).toBe(false);
    setBuffered(STREAM_BUFFER_LIMIT);
    expect(stream.send("output", 1, Uint8Array.of(1))).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sink.events).toEqual(["open"]);
  });

  it("send writes a decodable frame", () => {
    const { streams, sent } = setup();
    const { stream } = openCommitted(streams);
    stream.send("exit", 3, Uint8Array.of(0, 0, 0, 1));
    expect([...(sent[0] ?? [])].slice(0, 4)).toEqual([0x70, 1, FRAME_OPS.exit, 0]);
  });

  it("a throwing onClose does not stop closeAll", () => {
    const { streams } = setup();
    const last = recorder();
    openCommitted(
      streams,
      recorder({
        onClose: () => {
          throw new Error("boom");
        },
      }),
    );
    openCommitted(streams, last);
    expect(() => streams.closeAll()).not.toThrow();
    expect(last.events).toEqual(["open", "close"]);
  });
});
