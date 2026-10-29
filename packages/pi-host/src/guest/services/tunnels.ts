import type net from "node:net";
import {
  AGENT_VM_MAX_FRAME_BYTES,
  createFrameDecoder,
  encodeSocketFrame,
  TUNNEL_FRAME_BYTES,
  TUNNEL_WINDOW_BYTES,
  TunnelFrame,
} from "@pap/contracts/pi-host";
import { errorClass } from "../../bounded.ts";

/** Open tunnels one guest holds at once; the daemon's 32 per box is the real bound, the next open is refused. */
export const TUNNELS_PER_GUEST = 64;
/** A paused service socket resumes when the unacknowledged data is down to this much. */
const RESUME_BYTES = TUNNEL_WINDOW_BYTES / 2;
const PONG = encodeSocketFrame({ type: "pong" });
/** The one sentence the daemon gets for any open that fails before the side connection (never an address or an errno). */
export const TUNNEL_REFUSAL = "the service is not running or does not own its port";

export interface TunnelHostDeps {
  /** A connected socket to a running service's port, ownership checked again (spec §5); throws otherwise. */
  readonly services: { connectTo(serviceId: string): Promise<net.Socket> };
  /** The side connection of `slot`, its `tunnel` hello written (`dialSide(…, { role: "tunnel", slot })`). */
  side(slot: string): Promise<net.Socket>;
  /** Tells the daemon the slot could not open (an `exited` report with the slot and `TUNNEL_REFUSAL`). */
  refuse(slot: string, why: string): void;
  log(line: string): void;
}

export interface TunnelHost {
  open(command: { readonly slot: string; readonly service: string }): void;
  closeAll(): void;
  /** Open tunnels and tunnels being opened: the only entries this host keeps (red team I6). */
  size(): number;
}

/**
 * The guest's tunnels (UX-2 §6, UX2-R23). `tunnel_open` connects to the service first, then dials the side connection with
 * its hello, then splices: service bytes go out as `tunnel_data` of at most 64 KiB and stop while 1 MiB is unacknowledged
 * (resumed at half; the rest of a chunk waits, so the daemon never sees more than the window plus one frame); incoming data is
 * written to the service and acknowledged once written. The gateway's `ping` is answered with `pong` before any tunnel frame is
 * parsed (red team I4: the gateway closes a connection after three unanswered pings, 45 s). Red team I6: only open tunnels are
 * kept, and an entry goes when its tunnel ends; replaying a slot is the daemon's to refuse (it deleted the slot).
 */
export function createTunnelHost(deps: TunnelHostDeps): TunnelHost {
  const live = new Map<string, () => void>();

  function splice(slot: string, service: net.Socket, side: net.Socket, end: () => void): void {
    let sent = 0;
    let acked = 0;
    let written = 0;
    let paused = false;
    let held: Buffer | null = null;
    /** The service will send no more (its `end`, or its socket closed); `tunnel_end` goes once what it sent is out. */
    let finished = false;
    let endSent = false;
    let serviceClosed = false;
    const send = (frame: TunnelFrame): void => {
      if (!side.destroyed) side.write(encodeSocketFrame(frame));
    };
    const pump = (): void => {
      while (held !== null && sent - acked < TUNNEL_WINDOW_BYTES) {
        const part = held.subarray(0, TUNNEL_FRAME_BYTES);
        held = part.length < held.length ? held.subarray(part.length) : null;
        send({ type: "tunnel_data", data: part.toString("base64") });
        sent += part.length;
      }
      if (held === null && finished && !endSent) {
        endSent = true;
        send({ type: "tunnel_end" });
      }
      if (endSent && serviceClosed && side.writable) side.end();
      if (finished) return;
      const lag = sent - acked;
      const want = held === null && (paused ? lag <= RESUME_BYTES : lag < TUNNEL_WINDOW_BYTES);
      if (want === !paused) return;
      paused = !want;
      if (paused) service.pause();
      else service.resume();
    };
    const decoder = createFrameDecoder({
      maxBytes: () => AGENT_VM_MAX_FRAME_BYTES,
      onFrame: (raw) => {
        // Transport first (red team I4): the gateway's ping is no tunnel frame, and an unanswered one closes the connection.
        if ((raw as { type?: unknown } | null)?.type === "ping") {
          if (!side.destroyed) side.write(PONG);
          return;
        }
        const parsed = TunnelFrame.safeParse(raw);
        if (!parsed.success) {
          deps.log(`slot ${slot} tunnel frame refused`);
          return end();
        }
        const frame = parsed.data;
        if (frame.type === "tunnel_data") {
          const bytes = Buffer.from(frame.data, "base64");
          service.write(bytes, (error) => {
            if (error) return;
            written += bytes.length;
            send({ type: "tunnel_ack", bytes: written });
          });
        } else if (frame.type === "tunnel_ack") {
          if (frame.bytes > sent) {
            deps.log(`slot ${slot} acknowledged more than it was sent`);
            return end();
          }
          if (frame.bytes > acked) acked = frame.bytes;
          pump();
        } else service.end();
      },
      onError: (error) => {
        deps.log(`slot ${slot} tunnel frame refused (${error})`);
        end();
      },
    });
    side.on("data", (chunk: Buffer) => decoder.push(chunk));
    side.on("close", () => {
      decoder.stop();
      end();
    });
    side.on("error", (error) => deps.log(`slot ${slot} tunnel socket error: ${errorClass(error)}`));
    service.on("data", (chunk: Buffer) => {
      held = held === null ? chunk : Buffer.concat([held, chunk]);
      pump();
    });
    service.on("end", () => {
      finished = true;
      pump();
    });
    service.on("close", () => {
      finished = true;
      serviceClosed = true;
      pump();
    });
  }

  return {
    open(command) {
      const { slot } = command;
      if (live.has(slot)) return deps.log(`ignored tunnel_open of slot ${slot}: it is open`);
      if (live.size >= TUNNELS_PER_GUEST) return deps.refuse(slot, TUNNEL_REFUSAL);
      let ended = false;
      let spliced = false;
      let service: net.Socket | undefined;
      let side: net.Socket | undefined;
      const end = (): void => {
        if (ended) return;
        ended = true;
        live.delete(slot);
        service?.destroy();
        side?.destroy();
      };
      live.set(slot, end);
      void (async () => {
        try {
          service = await deps.services.connectTo(command.service);
        } catch (error) {
          if (ended) return;
          end();
          deps.log(`slot ${slot} refused: ${errorClass(error)}`);
          return deps.refuse(slot, TUNNEL_REFUSAL);
        }
        // An untrusted service can reset the connection while the side connection is dialled: no uncaught `error`.
        const early = service;
        early.on("error", (error) => deps.log(`slot ${slot} service socket error: ${errorClass(error)}`));
        early.on("close", () => {
          if (!spliced) end();
        });
        if (ended) return void service.destroy();
        try {
          side = await deps.side(slot);
        } catch (error) {
          deps.log(`slot ${slot} side connection failed: ${errorClass(error)}`);
          return end();
        }
        if (ended) return void side.destroy();
        // A socket that closed while it was awaited will never emit `close` again: the tunnel would hang with its entry.
        if (side.destroyed || service.destroyed) return end();
        spliced = true;
        splice(slot, service, side, end);
      })();
    },
    closeAll() {
      for (const end of [...live.values()]) end();
    },
    size: () => live.size,
  };
}
