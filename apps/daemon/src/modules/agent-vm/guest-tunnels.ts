import { randomBytes } from "node:crypto";
import { type GuestCommand, type Hello, PapError, TunnelFrame } from "@pap/contracts";
import type { BoxTunnelChannel } from "../../kernel/boxes.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Wire } from "./vm-worker.ts";

/** From `tunnel_open` to the tunnel hello: the guest's own connect timeout is 10 s. */
export const TUNNEL_OPEN_MS = 15_000;

/** What the gateway does with a tunnel connection that passed its hello. */
export interface TunnelConnection {
  frame(raw: unknown): void;
  closed(): void;
}

export type TunnelRefusal = "slot" | "duplicate";

export interface GuestTunnels {
  /** Asks the guest for a tunnel to the service; resolves once its `tunnel` hello was accepted. */
  open(serviceId: string): Promise<BoxTunnelChannel>;
  accept(hello: Extract<Hello, { role: "tunnel" }>, wire: Wire): TunnelConnection | TunnelRefusal;
  /** The guest reported `exited` for `slot` before any hello: the open fails `not_found`. False when the slot is not a tunnel's. */
  refused(slot: string): boolean;
  /** The guest's connection closed: every tunnel of the launch ends, every open fails `box_stopped`. */
  closed(): void;
  /** Slot entries held: asked ones and open tunnels only (red team I6). */
  size(): number;
}

interface Slot {
  /** `asked`: `tunnel_open` went out. `open`: the hello came; a second hello is `duplicate`. */
  state: "asked" | "open";
  readonly resolve: (channel: BoxTunnelChannel) => void;
  readonly reject: (error: Error) => void;
  timer: TimerHandle | undefined;
  end?: () => void;
}

/**
 * The daemon's half of the tunnels of one guest link (UX-2 §6), the shape of `guest-ptys.ts` with one difference (red team
 * I6): a tunnel opens once per relayed request, so a slot entry is deleted as soon as it is given up (timeout, refusal, the
 * link gone) or its tunnel closes. A hello for a deleted slot is refused `slot`, as one for a slot never asked.
 */
export function createGuestTunnels(deps: {
  clock: Clock;
  logger: Logger;
  box: string;
  wire: Wire;
}): GuestTunnels {
  const { clock, logger, box, wire } = deps;
  const slots = new Map<string, Slot>();
  let isClosed = false;

  const giveUp = (slot: string, entry: Slot, error: Error): void => {
    if (entry.state !== "asked") return;
    slots.delete(slot);
    if (entry.timer) clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.reject(error);
  };

  function channelOf(
    slot: string,
    connection: Wire,
  ): { channel: BoxTunnelChannel; connection: TunnelConnection } {
    let listener: ((frame: TunnelFrame) => void) | undefined;
    const queued: TunnelFrame[] = [];
    let ended = false;
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const end = (): void => {
      if (ended) return;
      ended = true;
      slots.delete(slot);
      markClosed();
    };
    const channel: BoxTunnelChannel = {
      send: (frame) => !ended && connection.send(frame),
      onFrame(next) {
        listener = next;
        for (const frame of queued.splice(0)) next(frame);
      },
      closed,
      close: () => connection.close(),
    };
    return {
      channel,
      connection: {
        frame(raw) {
          const frame = TunnelFrame.safeParse(raw);
          if (!frame.success) {
            // Transport frames never reach here (the gateway answers them): anything else ends the tunnel, never its content logged.
            logger.warn("agent_gateway_tunnel_bad_frame", { box });
            connection.close();
            return;
          }
          if (listener) listener(frame.data);
          else queued.push(frame.data);
        },
        closed: end,
      },
    };
  }

  return {
    open(serviceId) {
      if (isClosed) return Promise.reject(new PapError("box_stopped"));
      const slot = randomBytes(16).toString("hex");
      return new Promise<BoxTunnelChannel>((resolve, reject) => {
        const entry: Slot = { state: "asked", resolve, reject, timer: undefined };
        entry.timer = clock.setTimeout(() => {
          logger.warn("agent_gateway_tunnel_timeout", { box });
          giveUp(slot, entry, new PapError("timeout"));
        }, TUNNEL_OPEN_MS);
        slots.set(slot, entry);
        const command: GuestCommand = { type: "tunnel_open", slot, service: serviceId };
        if (!wire.send(command)) giveUp(slot, entry, new PapError("box_stopped"));
      });
    },
    accept(hello, tunnelWire) {
      const entry = slots.get(hello.slot);
      if (entry === undefined) return "slot";
      if (entry.state !== "asked") return "duplicate";
      entry.state = "open";
      if (entry.timer) clock.clearTimeout(entry.timer);
      entry.timer = undefined;
      const { channel, connection } = channelOf(hello.slot, tunnelWire);
      entry.end = () => {
        connection.closed();
        tunnelWire.close();
      };
      entry.resolve(channel);
      return connection;
    },
    refused(slot) {
      const entry = slots.get(slot);
      if (entry === undefined) return false;
      giveUp(slot, entry, new PapError("not_found"));
      return true;
    },
    closed() {
      isClosed = true;
      for (const [slot, entry] of [...slots]) {
        giveUp(slot, entry, new PapError("box_stopped"));
        entry.end?.();
      }
    },
    size: () => slots.size,
  };
}
