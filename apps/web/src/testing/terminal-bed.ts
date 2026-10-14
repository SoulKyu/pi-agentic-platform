import { CLIENT_OPS, decodeFrame, encodeFrame, FRAME_OPS, type BinaryFrame } from "@pap/contracts";
import { vi } from "vitest";
import type { RpcClient } from "../runtime/rpc.ts";
import { createTerminalChannel, type TerminalSink } from "../runtime/terminal-channel.ts";
import { fakeConnection, flush } from "../runtime/testing.ts";

export const TERMINAL_ID = "AAAAAAAAAAAAAAAAAAAAAA";
const encoder = new TextEncoder();

type Handler = (params: unknown) => unknown;

/** The channel over a fake connection, a scripted rpc, virtual timers, a switchable page visibility and a recording sink. */
export function terminalBed(options: { manualWrites?: boolean } = {}) {
  const fake = fakeConnection("open");
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const handlers: Record<string, Handler> = {};
  let streams = 0;
  // Like the daemon: one stream per terminal per connection, a repeat attach returns it (terminal.ts attach).
  const streamOf = new Map<string, number>();
  fake.connection.onState((state) => {
    if (state !== "open") streamOf.clear();
  });
  // Answers computed when the request arrives (the daemon decides then) but delivered on `release()`.
  let held = false;
  const waiting: Array<() => void> = [];
  const rpc = {
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params: params as Record<string, unknown> });
      const handler = handlers[method];
      if (handler) return handler(params);
      if (method === "terminal.attach") {
        const terminalId = (params as { terminalId: string }).terminalId;
        const streamId = streamOf.get(terminalId) ?? ++streams;
        streamOf.set(terminalId, streamId);
        const answer = { streamId, start: 0, end: 0, cols: 80, rows: 24, status: "running" };
        if (!held) return answer;
        return new Promise((resolve) => waiting.push(() => resolve(answer)));
      }
      if (method === "terminal.detach") {
        for (const [terminalId, id] of streamOf) {
          if (id === (params as { streamId: number }).streamId) streamOf.delete(terminalId);
        }
      }
      return { ok: true };
    }),
  } as unknown as RpcClient;

  let now = 0;
  let nextTimer = 1;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers = {
    set: (fn: () => void, ms: number) => {
      pending.set(nextTimer, { at: now + ms, fn });
      return nextTimer++;
    },
    clear: (id: number) => {
      pending.delete(id);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now && pending.has(id)) {
        pending.delete(id);
        timer.fn();
      }
    }
  };

  let hidden = false;
  const visibilityListeners = new Set<() => void>();
  const visibility = {
    hidden: () => hidden,
    onChange: (listener: () => void) => {
      visibilityListeners.add(listener);
      return () => {
        visibilityListeners.delete(listener);
      };
    },
  };
  const setHidden = (next: boolean) => {
    hidden = next;
    for (const listener of [...visibilityListeners]) listener();
  };

  const writes: Array<() => void> = [];
  const log: string[] = [];
  const makeSink = () =>
    ({
      attached: vi.fn((info: Parameters<TerminalSink["attached"]>[0]) => void info),
      reset: vi.fn(() => void log.push("reset")),
      output: vi.fn((bytes: Uint8Array, end: number) => {
        log.push(`output:${end}`);
        void bytes;
        if (!options.manualWrites) return Promise.resolve();
        return new Promise<void>((resolve) => writes.push(resolve));
      }),
      exit: vi.fn((code: number | null, signal: string | null) => void log.push(`exit:${code}:${signal}`)),
      state: vi.fn((state: string) => void state),
    }) satisfies Record<keyof TerminalSink, unknown>;
  const sink = makeSink();

  const channel = createTerminalChannel({ connection: fake.connection, rpc, timers, visibility });
  const frame = (op: keyof typeof FRAME_OPS, streamId: number, seq: number, payload = new Uint8Array(0)) =>
    fake.deliverBinary(encodeFrame({ op: FRAME_OPS[op] as BinaryFrame["op"], streamId, seq, payload }));
  return {
    fake,
    channel,
    sink,
    terminalSink: makeSink,
    calls,
    handlers,
    log,
    advance,
    timers,
    setHidden,
    /** From now on attach answers wait for `release()`. */
    holdAttaches: () => {
      held = true;
    },
    release: async () => {
      held = false;
      for (const answer of waiting.splice(0)) answer();
      await flush();
    },
    called: (method: string) => calls.filter((entry) => entry.method === method),
    /** Server output on a stream: `bytes` long, starting at offset `seq`. */
    output: (streamId: number, seq: number, bytes: number | string) =>
      frame(
        "output",
        streamId,
        seq,
        typeof bytes === "string" ? encoder.encode(bytes) : new Uint8Array(bytes).fill(0x61),
      ),
    reset: (streamId: number, seq: number) => frame("reset", streamId, seq),
    exit: (streamId: number, seq: number, code: number | null, signal: string | null) =>
      frame("exit", streamId, seq, encoder.encode(JSON.stringify({ code, signal }))),
    /** Resolves the oldest `count` sink writes still waiting (manual writes only). */
    finishWrites: async (count: number) => {
      for (const resolve of writes.splice(0, count)) resolve();
      await flush();
    },
    /** Client frames the channel sent, decoded. */
    sentFrames: () =>
      fake.sentBinary
        .map((bytes) => decodeFrame(bytes, CLIENT_OPS))
        .filter((f): f is BinaryFrame => f !== null),
    acks: () =>
      fake.sentBinary
        .map((bytes) => decodeFrame(bytes, CLIENT_OPS))
        .filter((f) => f?.op === FRAME_OPS.ack)
        .map((f) => (f as BinaryFrame).seq),
  };
}
