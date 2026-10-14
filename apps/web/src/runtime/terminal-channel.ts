import {
  encodeFrame,
  decodeFrame,
  FRAME_OPS,
  SERVER_OPS,
  TERMINAL_LIMITS,
  TerminalExit,
  type BinaryFrame,
  type ResultOf,
} from "@pap/contracts";
import { getRuntime, windowTimers } from "./index.ts";
import { splitUtf8 } from "./split-utf8.ts";
import {
  clamp,
  isConnectionLoss,
  safeJson,
  type Entry,
  type Pending,
  type SinkState,
} from "./terminal-entry.ts";
import {
  ACK_EVERY_BYTES,
  HIDDEN_DETACH_MS,
  type PageVisibility,
  type TerminalChannel,
  type TerminalChannelDeps,
} from "./terminal-types.ts";

export type { TerminalChannel, TerminalSink } from "./terminal-types.ts";

export function createTerminalChannel(deps: TerminalChannelDeps): TerminalChannel & { dispose(): void } {
  const { connection, rpc, timers, visibility } = deps;
  const entries = new Map<string, Entry>();
  const byStream = new Map<number, Entry>();
  // The server hands the same stream back to a second attach from one connection, so a second request in flight
  // would make two owners of one stream. One request per terminal per socket; its answer goes to whoever wants the
  // terminal when it arrives (MC31).
  const pending = new Map<string, Pending>();
  // Bumped whenever the socket leaves `open`: stream ids belong to one socket.
  let link = 0;

  const show = (entry: Entry, state: SinkState): void => {
    if (entry.shown === state) return;
    entry.shown = state;
    entry.sink.state(state);
  };
  const logUnlessLost = (what: string, error: unknown): void => {
    if (!isConnectionLoss(error)) console.warn(what, (error as { code?: unknown } | null)?.code ?? "failed");
  };
  // A detach that cannot be sent needs no retry: the server drops a socket's streams when the socket closes.
  const detachStream = (streamId: number): void => {
    rpc
      .call("terminal.detach", { streamId })
      .catch((error: unknown) => logUnlessLost("terminal_detach_failed", error));
  };
  const afterWrites = (entry: Entry, run: () => void): void => {
    if (entry.writing.size === 0) run();
    else {
      void Promise.allSettled([...entry.writing])
        .then(run)
        .catch((error: unknown) => console.error("terminal_sink_failed", error));
    }
  };

  const sendAck = (entry: Entry): void => {
    if (entry.written === null || entry.streamId === null || entry.written <= entry.lastAcked) return;
    const frame = {
      op: FRAME_OPS.ack,
      streamId: entry.streamId,
      seq: entry.written,
      payload: new Uint8Array(0),
    };
    if (!connection.sendBinary(encodeFrame(frame))) return;
    entry.lastAcked = entry.written;
    entry.unacked = 0;
  };

  const write = (entry: Entry, frame: BinaryFrame): void => {
    const end = frame.seq + frame.payload.byteLength;
    // The first frame, not the attach answer, says where the bytes are (the ring may have moved since).
    entry.written ??= frame.seq;
    const epoch = entry.epoch;
    const done: Promise<void> = new Promise<void>((resolve) => resolve(entry.sink.output(frame.payload, end)))
      .catch((error: unknown) => {
        // Counted as written: a screen that cannot write must not stall the shell behind it.
        console.error("terminal_sink_write_failed", error);
      })
      .then(() => {
        entry.writing.delete(done);
        if (epoch === entry.epoch) {
          entry.written = Math.max(entry.written ?? 0, end);
          entry.unacked += frame.payload.byteLength;
        }
        if (entry.writing.size === 0 || entry.unacked >= ACK_EVERY_BYTES) sendAck(entry);
      });
    entry.writing.add(done);
  };

  const onFrame = (frame: BinaryFrame): void => {
    const entry = byStream.get(frame.streamId);
    if (!entry) return;
    if (frame.op === FRAME_OPS.output) {
      write(entry, frame);
    } else if (frame.op === FRAME_OPS.reset) {
      entry.epoch++;
      entry.written = frame.seq;
      entry.lastAcked = frame.seq;
      entry.unacked = 0;
      entry.sink.reset();
    } else if (frame.op === FRAME_OPS.exit) {
      const exit = TerminalExit.safeParse(safeJson(frame.payload));
      const { code, signal } = exit.success ? exit.data : { code: null, signal: null };
      afterWrites(entry, () => {
        if (!entry.closed) entry.sink.exit(code, signal);
      });
    }
  };

  const attach = (entry: Entry): void => {
    if (entry.closed || entry.gone || connection.state !== "open") return;
    const mine = ++entry.gen;
    entry.hiddenDetached = false;
    show(entry, "attaching");
    if (visibility.hidden()) armHide(entry);
    const go = (): void => {
      // Stale, already served by an answer that arrived while the writes settled, or a request is on its way.
      if (mine !== entry.gen || entry.streamId !== null || pending.has(entry.terminalId)) return;
      const request: Pending = { link, after: entry.written };
      pending.set(entry.terminalId, request);
      rpc
        .call("terminal.attach", {
          terminalId: entry.terminalId,
          ...(entry.written === null ? {} : { after: entry.written }),
        })
        .then(
          (info) => answered(request, entry.terminalId, info),
          (error: unknown) => refused(request, entry.terminalId, error),
        )
        .catch((error: unknown) => console.error("terminal_sink_failed", error));
    };
    // The offset named to the server is what the screen has, so writes still in flight finish first.
    afterWrites(entry, go);
  };

  const wants = (entry: Entry | undefined): entry is Entry =>
    entry !== undefined &&
    !entry.closed &&
    !entry.gone &&
    !entry.hiddenDetached &&
    entry.streamId === null &&
    connection.state === "open";

  const sendResize = (entry: Entry): void => {
    if (!entry.size) return;
    rpc.call("terminal.resize", { terminalId: entry.terminalId, ...entry.size }).catch((error: unknown) => {
      if ((error as { code?: unknown } | null)?.code === "not_found") {
        entry.gone = true;
        show(entry, "gone");
      } else logUnlessLost("terminal_resize_failed", error);
    });
  };

  const answered = (request: Pending, terminalId: string, info: ResultOf<"terminal.attach">): void => {
    if (pending.get(terminalId) === request) pending.delete(terminalId);
    // Another socket owns its own stream ids: nothing to release on this one.
    if (request.link !== link) return;
    const entry = entries.get(terminalId);
    if (entry?.streamId === info.streamId) return;
    if (!wants(entry)) {
      detachStream(info.streamId);
      return;
    }
    if (entry.written !== request.after) {
      // The request asked for another start than this entry needs: a new stream, then asked again.
      detachStream(info.streamId);
      attach(entry);
      return;
    }
    entry.streamId = info.streamId;
    byStream.set(info.streamId, entry);
    entry.inputSeq = 0;
    entry.lastAcked = -1;
    entry.unacked = 0;
    entry.sink.attached({
      start: info.start,
      end: info.end,
      cols: info.cols,
      rows: info.rows,
      status: info.status,
    });
    show(entry, "live");
    if (entry.size && (entry.size.cols !== info.cols || entry.size.rows !== info.rows)) sendResize(entry);
  };

  const refused = (request: Pending, terminalId: string, error: unknown): void => {
    if (pending.get(terminalId) === request) pending.delete(terminalId);
    const entry = entries.get(terminalId);
    if (request.link !== link || !entry || entry.closed || entry.hiddenDetached) return;
    const code = (error as { code?: unknown } | null)?.code;
    if (code === "not_found") {
      entry.gone = true;
      show(entry, "gone");
    } else if (!isConnectionLoss(error)) {
      // `capacity` and the like: no stream now; the next reconnect or visible page asks again. A full server is not
      // an offline one: the screen says so and retries when a slot frees (MC31).
      console.warn("terminal_attach_failed", code ?? "failed");
      show(entry, code === "capacity" ? "busy" : "offline");
    }
  };

  function armHide(entry: Entry): void {
    if (entry.hideTimer !== null || entry.closed || entry.gone || entry.hiddenDetached) return;
    entry.hideTimer = timers.set(() => {
      entry.hideTimer = null;
      if (visibility.hidden()) hiddenDetach(entry);
    }, HIDDEN_DETACH_MS);
  }
  const disarmHide = (entry: Entry): void => {
    if (entry.hideTimer !== null) timers.clear(entry.hideTimer);
    entry.hideTimer = null;
  };
  const hiddenDetach = (entry: Entry): void => {
    entry.hiddenDetached = true;
    entry.gen++;
    release(entry);
  };
  /** Forgets the entry's stream and tells the server. */
  function release(entry: Entry): void {
    const streamId = entry.streamId;
    entry.streamId = null;
    if (streamId === null) return;
    byStream.delete(streamId);
    detachStream(streamId);
  }

  const stopFrames = connection.onBinary((data) => {
    const frame = decodeFrame(new Uint8Array(data), SERVER_OPS);
    if (frame) onFrame(frame);
  });
  const stopState = connection.onState((state) => {
    if (state !== "open") {
      link++;
      byStream.clear();
      pending.clear();
      for (const entry of entries.values()) {
        entry.gen++;
        entry.streamId = null;
        if (!entry.gone) show(entry, "offline");
      }
      return;
    }
    for (const entry of entries.values()) {
      if (!(entry.hiddenDetached && visibility.hidden())) attach(entry);
    }
  });
  const stopVisibility = visibility.onChange(() => {
    for (const entry of entries.values()) {
      if (visibility.hidden()) {
        armHide(entry);
      } else {
        disarmHide(entry);
        if (entry.hiddenDetached) attach(entry);
      }
    }
  });

  return {
    open(terminalId, sink) {
      if (entries.has(terminalId)) throw new Error("terminal already open");
      const entry: Entry = {
        terminalId,
        sink,
        closed: false,
        gone: false,
        hiddenDetached: false,
        gen: 0,
        epoch: 0,
        streamId: null,
        shown: null,
        written: null,
        lastAcked: -1,
        unacked: 0,
        inputSeq: 0,
        size: null,
        writing: new Set(),
        hideTimer: null,
      };
      entries.set(terminalId, entry);
      if (connection.state === "open") attach(entry);
      else show(entry, "offline");
      return {
        input(data) {
          if (entry.closed || entry.streamId === null || connection.state !== "open") return false;
          for (const part of splitUtf8(data)) {
            const frame = {
              op: FRAME_OPS.input,
              streamId: entry.streamId,
              seq: ++entry.inputSeq,
              payload: part,
            };
            if (!connection.sendBinary(encodeFrame(frame))) return false;
          }
          return true;
        },
        resize(cols, rows) {
          // A pane with no size yet (hidden, not laid out) has nothing to ask for.
          if (entry.closed || !(cols >= 1) || !(rows >= 1)) return;
          entry.size = { cols: clamp(cols, TERMINAL_LIMITS.cols), rows: clamp(rows, TERMINAL_LIMITS.rows) };
          if (entry.streamId !== null) sendResize(entry);
        },
        close() {
          if (entry.closed) return;
          entry.closed = true;
          entry.gen++;
          entries.delete(terminalId);
          disarmHide(entry);
          release(entry);
        },
      };
    },
    dispose() {
      stopFrames();
      stopState();
      stopVisibility();
      for (const entry of entries.values()) disarmHide(entry);
      entries.clear();
      byStream.clear();
      pending.clear();
    },
  };
}

const documentVisibility: PageVisibility = {
  hidden: () => document.visibilityState === "hidden",
  onChange: (listener) => {
    document.addEventListener("visibilitychange", listener);
    return () => document.removeEventListener("visibilitychange", listener);
  },
};

let built: {
  runtime: ReturnType<typeof getRuntime>;
  channel: ReturnType<typeof createTerminalChannel>;
} | null = null;

/** The one channel of this page, over the current runtime; a new runtime (hot update, sign-out) gets a new one. */
export function getTerminalChannel(): TerminalChannel {
  const runtime = getRuntime();
  if (built?.runtime === runtime) return built.channel;
  built?.channel.dispose();
  const channel = createTerminalChannel({
    connection: runtime.connection,
    rpc: runtime.rpc,
    timers: windowTimers,
    visibility: documentVisibility,
  });
  built = { runtime, channel };
  return channel;
}
