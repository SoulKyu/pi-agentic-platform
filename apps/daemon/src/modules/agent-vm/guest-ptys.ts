import { randomBytes } from "node:crypto";
import { type GuestCommand, PapError, PTY_FOLDER_REFUSAL, PtyReport, type Hello } from "@pap/contracts";
import type { BoxPtyChannel } from "../../kernel/boxes.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { Wire } from "./vm-worker.ts";

/** From `pty_open` to the terminal hello: the guest's own connect timeout is 10 s. */
export const PTY_OPEN_MS = 15_000;

/** What the gateway does with a terminal connection that passed its hello (the same shape as a worker's). */
export interface TerminalConnection {
  frame(raw: unknown): void;
  closed(): void;
}

export type TerminalRefusal = "slot" | "duplicate";

export interface GuestPtys {
  /** Asks the guest for a pty; resolves once its `terminal` hello was accepted. */
  open(input: { cwd: string; cols: number; rows: number }): Promise<BoxPtyChannel>;
  accept(hello: Extract<Hello, { role: "terminal" }>, wire: Wire): TerminalConnection | TerminalRefusal;
  /** The guest reported `exited` for `slot` before any hello: the open failed. False when the slot is not a pty's. */
  refused(slot: string, tail: string): boolean;
  /** The guest's connection closed: every pty of the launch ends. */
  closed(): void;
}

interface Slot {
  /** `asked`: `pty_open` went out. `used`: the hello came, or the open was given up; never again. */
  state: "asked" | "used";
  readonly resolve: (channel: BoxPtyChannel) => void;
  readonly reject: (error: Error) => void;
  timer: TimerHandle | undefined;
  /** The live connection once accepted. */
  end?: () => void;
}

/** The guest says why in its `exited` tail: the folder is not the project's, or node-pty is missing, or the shell did not start. */
const openError = (tail: string): PapError =>
  new PapError(tail.includes(PTY_FOLDER_REFUSAL) ? "not_found" : "terminal_unavailable");

export function createGuestPtys(deps: { clock: Clock; logger: Logger; box: string; wire: Wire }): GuestPtys {
  const { clock, logger, box, wire } = deps;
  const slots = new Map<string, Slot>();
  let isClosed = false;

  const giveUp = (entry: Slot, error: Error): void => {
    if (entry.state !== "asked") return;
    entry.state = "used";
    if (entry.timer) clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.reject(error);
  };

  function channelOf(
    slot: string,
    connection: Wire,
  ): { channel: BoxPtyChannel; connection: TerminalConnection } {
    let listener: ((report: PtyReport) => void) | undefined;
    const queued: PtyReport[] = [];
    let ended = false;
    let dropped = 0;
    let markClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve;
    });
    const end = (): void => {
      if (ended) return;
      ended = true;
      markClosed();
    };
    const channel: BoxPtyChannel = {
      send: (command) => !ended && connection.send(command),
      onReport(next) {
        listener = next;
        for (const report of queued.splice(0)) next(report);
      },
      closed,
      close: () => connection.close(),
    };
    return {
      channel,
      connection: {
        frame(raw) {
          const report = PtyReport.safeParse(raw);
          if (!report.success) {
            dropped++;
            if ((dropped & (dropped - 1)) === 0)
              logger.warn("agent_gateway_pty_dropped", { box, slot, dropped });
            return;
          }
          if (listener) listener(report.data);
          else queued.push(report.data);
        },
        closed: end,
      },
    };
  }

  return {
    open({ cwd, cols, rows }) {
      if (isClosed) return Promise.reject(new PapError("box_stopped"));
      const slot = randomBytes(16).toString("hex");
      return new Promise<BoxPtyChannel>((resolve, reject) => {
        const entry: Slot = { state: "asked", resolve, reject, timer: undefined };
        entry.timer = clock.setTimeout(() => {
          logger.warn("agent_gateway_pty_timeout", { box });
          giveUp(entry, new PapError("timeout"));
        }, PTY_OPEN_MS);
        slots.set(slot, entry);
        if (!wire.send({ type: "pty_open", slot, cwd, cols, rows } satisfies GuestCommand)) {
          giveUp(entry, new PapError("box_stopped"));
        }
      });
    },
    accept(hello, terminalWire) {
      const entry = slots.get(hello.slot);
      if (entry === undefined) return "slot";
      if (entry.state !== "asked") return "duplicate";
      entry.state = "used";
      if (entry.timer) clock.clearTimeout(entry.timer);
      entry.timer = undefined;
      const { channel, connection } = channelOf(hello.slot, terminalWire);
      entry.end = () => {
        connection.closed();
        terminalWire.close();
      };
      void channel.closed.then(() => slots.delete(hello.slot));
      entry.resolve(channel);
      return connection;
    },
    refused(slot, tail) {
      const entry = slots.get(slot);
      if (entry === undefined) return false;
      giveUp(entry, openError(tail));
      return true;
    },
    closed() {
      isClosed = true;
      for (const entry of [...slots.values()]) {
        giveUp(entry, new PapError("box_stopped"));
        entry.end?.();
      }
    },
  };
}
