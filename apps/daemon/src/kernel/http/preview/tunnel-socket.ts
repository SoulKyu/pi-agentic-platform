import { Duplex } from "node:stream";
import { TUNNEL_FRAME_BYTES, TUNNEL_WINDOW_BYTES } from "@pap/contracts";
import type { BoxTunnelChannel } from "../../boxes.ts";

/** A guest may have this much unacknowledged data in flight: the window plus the one frame it may send while it fills. */
export const TUNNEL_RECEIVE_LIMIT = TUNNEL_WINDOW_BYTES + TUNNEL_FRAME_BYTES;

export class TunnelWindowBroken extends Error {
  override name = "TunnelWindowBroken";
}

/**
 * The stream the listener's `http.request({ createConnection })` and the WebSocket splice read and write (UX2-R25).
 * Out: a write is cut into frames of at most 64 KiB, and the rest of it waits, callback held, while 1 MiB is unacknowledged.
 * In: data is pushed and acknowledged cumulatively, except while `push` refuses (acks resume on `_read`). Red team I5: the
 * receiving side enforces the window, so a guest that ignores missing acks is cut (`TunnelWindowBroken`) once it has more
 * than `TUNNEL_RECEIVE_LIMIT` unacknowledged, before anything past it is buffered; an ack beyond what was sent is cut too.
 * The channel closing destroys the socket: at once mid-answer, after its buffered data was read once `tunnel_end` came.
 */
export function tunnelSocket(channel: BoxTunnelChannel): Duplex {
  let sent = 0;
  let acked = 0;
  let received = 0;
  let ackedOut = 0;
  let held: { chunk: Buffer; done: (error?: Error | null) => void } | null = null;
  let remoteEnded = false;

  const pump = (): void => {
    while (held !== null && sent - acked < TUNNEL_WINDOW_BYTES) {
      const part = held.chunk.subarray(0, TUNNEL_FRAME_BYTES);
      if (!channel.send({ type: "tunnel_data", data: part.toString("base64") })) {
        const { done } = held;
        held = null;
        return done(new Error("the tunnel is closed"));
      }
      sent += part.length;
      if (part.length < held.chunk.length) held = { ...held, chunk: held.chunk.subarray(part.length) };
      else {
        const { done } = held;
        held = null;
        done();
      }
    }
  };
  const ack = (): void => {
    if (received === ackedOut) return;
    ackedOut = received;
    channel.send({ type: "tunnel_ack", bytes: ackedOut });
  };

  const socket = new Duplex({
    write(chunk: Buffer, _encoding, done) {
      if (chunk.length === 0) return done();
      held = { chunk, done };
      pump();
    },
    final(done) {
      channel.send({ type: "tunnel_end" });
      done();
    },
    read() {
      ack();
    },
    destroy(error, done) {
      if (held !== null) {
        const pending = held.done;
        held = null;
        pending(error ?? new Error("the tunnel is closed"));
      }
      channel.close();
      done(error);
    },
  });

  channel.onFrame((frame) => {
    if (socket.destroyed) return;
    if (frame.type === "tunnel_ack") {
      if (frame.bytes > sent)
        return void socket.destroy(new TunnelWindowBroken("an ack beyond what was sent"));
      if (frame.bytes > acked) acked = frame.bytes;
      pump();
    } else if (frame.type === "tunnel_data") {
      const bytes = Buffer.from(frame.data, "base64");
      received += bytes.length;
      if (received - ackedOut > TUNNEL_RECEIVE_LIMIT)
        return void socket.destroy(new TunnelWindowBroken("the guest sent past its window"));
      if (socket.push(bytes)) ack();
    } else {
      remoteEnded = true;
      socket.push(null);
    }
  });
  // The guest ended the connection: after its `tunnel_end` the socket goes once what it sent was read; before it, at once.
  void channel.closed.then(() => {
    if (socket.destroyed) return;
    if (!remoteEnded || socket.readableEnded) socket.destroy();
    else socket.once("end", () => socket.destroy());
  });
  return socket;
}
