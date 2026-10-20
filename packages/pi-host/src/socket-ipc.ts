import type net from "node:net";
import type { z } from "zod";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  DaemonToWorker,
  encodeSocketFrame,
  WorkerHello,
} from "@pap/contracts";
import { logLineOf } from "./bounded.ts";
import { MAX_RECORD_BYTES, type Ipc, type Outbound } from "./ipc.ts";

const PONG = encodeSocketFrame({ type: "pong" });

/**
 * The worker's `Ipc` over a TCP socket to the daemon's gateway: length-prefixed JSON frames, the hello first. A ping is
 * answered here and never reaches the listener. A frame over the bound, bad JSON or a closed socket ends the channel
 * once (`onDisconnect`), and the decoder is stopped so nothing is delivered after.
 */
export function createSocketIpc(socket: net.Socket, hello: z.infer<typeof WorkerHello>): Ipc {
  const closedListeners: Array<() => void> = [];
  const messageListeners = new Set<{
    listener: (record: DaemonToWorker) => void;
    onMalformed?: (raw: unknown) => void;
  }>();
  let closed = false;
  const markClosed = (): void => {
    if (closed) return;
    closed = true;
    decoder.stop();
    socket.destroy();
    for (const listener of closedListeners.splice(0)) listener();
  };
  const decoder = createFrameDecoder({
    maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
    onError: (error) => {
      process.stderr.write(`pi-host: socket frame refused (${error})\n`);
      markClosed();
    },
    onFrame: (raw) => {
      if (typeof raw === "object" && raw !== null && (raw as { type?: unknown }).type === "ping") {
        if (!closed) socket.write(PONG);
        return;
      }
      const parsed = DaemonToWorker.safeParse(raw);
      if (parsed.success) {
        for (const entry of [...messageListeners]) entry.listener(parsed.data);
        return;
      }
      // Field names only: a rejected record may carry anything, and nothing of it belongs in a log.
      const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join(".") || "<record>"))];
      process.stderr.write(
        `pi-host: dropped a malformed record (fields: ${fields.slice(0, 8).join(", ")})\n`,
      );
      for (const entry of [...messageListeners]) entry.onMalformed?.(raw);
    },
  });
  socket.on("data", (chunk) => decoder.push(chunk));
  socket.on("close", markClosed);
  socket.on("error", (error) => {
    process.stderr.write(`pi-host: socket error: ${logLineOf(error)}\n`);
    markClosed();
  });

  const write = (frame: Buffer): boolean => {
    if (closed || socket.destroyed) {
      markClosed();
      return false;
    }
    // A backed-up socket still queues the frame; only a socket that is gone is a closed channel.
    socket.write(frame);
    return true;
  };
  const refuse = (record: Outbound, size: number): void => {
    const type = logLineOf(record.type).slice(0, 64);
    process.stderr.write(
      `pi-host: dropped a ${type} record of ${size} bytes: the limit is ${MAX_RECORD_BYTES}\n`,
    );
    if (record.type === "response" && typeof record.id === "string") {
      deliver({
        type: "response",
        id: record.id,
        command: logLineOf(record.command).slice(0, 64),
        success: false,
        error: "record too large",
      });
    } else {
      deliver({
        type: "extension_error",
        extensionPath: "pi-host:ipc",
        event: type,
        error: `a record of ${size} bytes was dropped: the limit is ${MAX_RECORD_BYTES}`,
      });
    }
  };
  const deliver = (record: Outbound): boolean => {
    let frame: Buffer;
    try {
      const size = Buffer.byteLength(JSON.stringify(record));
      if (size > MAX_RECORD_BYTES) {
        refuse(record, size);
        return false;
      }
      frame = encodeSocketFrame(record);
    } catch (error) {
      process.stderr.write(
        `pi-host: a ${logLineOf(record.type).slice(0, 64)} record could not be sent: ${logLineOf(error)}\n`,
      );
      if (record.type === "response" && typeof record.id === "string") {
        deliver({
          type: "response",
          id: record.id,
          command: logLineOf(record.command).slice(0, 64),
          success: false,
          error: "response could not be sent",
        });
      }
      return false;
    }
    return write(frame);
  };

  write(encodeSocketFrame(hello));
  return {
    send: deliver,
    onMessage(listener, onMalformed) {
      const entry = { listener, onMalformed };
      messageListeners.add(entry);
      return () => {
        messageListeners.delete(entry);
      };
    },
    onDisconnect(listener) {
      if (closed) listener();
      else closedListeners.push(listener);
    },
  };
}
