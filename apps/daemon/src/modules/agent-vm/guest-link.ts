import { randomBytes } from "node:crypto";
import {
  type BoxOp,
  GUEST_BOOT_TIMEOUT_MS,
  GuestReport,
  type GuestCommand,
  type Hello,
  PapError,
  SessionFileName,
} from "@pap/contracts";
import type { BoxPtyChannel } from "../../kernel/boxes.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { classifyExit } from "../../kernel/supervisor/exit.ts";
import { createGuestPtys, type TerminalConnection, type TerminalRefusal } from "./guest-ptys.ts";
import {
  createVmWorker,
  type MirrorPort,
  type PackagePicks,
  type VmWorkerHandle,
  type VmWorker,
  type Wire,
  type WorkerSpawnInput,
} from "./vm-worker.ts";

/** The guest's answer to a {@link GuestLink.sendOp}. */
export type OpResult = Extract<GuestReport, { type: "op_result" }>;

export interface GuestLink {
  /** Asks the guest to start a worker; resolves once the worker's hello arrived (`init` is sent after, never dropped). */
  spawnWorker(input: WorkerSpawnInput, packages: PackagePicks): Promise<VmWorkerHandle>;
  shutdown(): void;
  /** Asks the guest for one operation on its project; false when the link is gone. The answer comes through {@link onOpResult}. */
  sendOp(id: string, op: BoxOp): boolean;
  /** Asks the guest for a pty in a folder of the project; resolves once its terminal connection said hello (lot B2). */
  openTerminal(input: { cwd: string; cols: number; rows: number }): Promise<BoxPtyChannel>;
  /** Every `op_result` the guest sends, until the returned function is called. */
  onOpResult(listener: (result: OpResult) => void): () => void;
  readonly closed: Promise<void>;
}

type WorkerHello = Extract<Hello, { role: "worker" }>;

export type WorkerRefusal = "slot" | "duplicate" | "protocol";

/** What the gateway does with a worker connection that passed its hello. */
export interface WorkerConnection {
  frame(raw: unknown): void;
  closed(): void;
}

export interface GuestLinkInternals {
  readonly link: GuestLink;
  /** A worker's hello on a new connection of this launch: the connection's handlers, or why it is refused. */
  acceptWorker(hello: WorkerHello, wire: Wire): WorkerConnection | WorkerRefusal;
  /** A terminal's hello on a new connection of this launch: the slot must have been asked by an `openTerminal`. */
  acceptTerminal(
    hello: Extract<Hello, { role: "terminal" }>,
    wire: Wire,
  ): TerminalConnection | TerminalRefusal;
  /** One frame from the guest's own connection (not a ping or pong). */
  frame(raw: unknown): void;
  /** The guest's connection closed. */
  closed(): void;
}

interface Slot {
  /** `asked`: the spawn command went out. `used`: a worker said hello, or the slot was given up; never again. */
  state: "asked" | "used";
  readonly input: WorkerSpawnInput;
  readonly resolve: (handle: VmWorkerHandle) => void;
  readonly reject: (error: Error) => void;
  timer: TimerHandle | undefined;
  worker?: VmWorker;
  wire?: Wire;
}

/** What a slot keeps once its worker has exited: the fact that it was used, so a later hello is a duplicate and not an unknown slot. */
const USED = "used" as const;

// Powers of two, like the worker core: a guest that floods garbage cannot flood the log.
const worthLogging = (count: number): boolean => (count & (count - 1)) === 0;

export function createGuestLink(deps: {
  clock: Clock;
  logger: Logger;
  /** `boxKey` of the box: only a log label here. */
  box: string;
  wire: Wire;
}): GuestLinkInternals {
  const { clock, logger, box, wire } = deps;
  const slots = new Map<string, Slot | typeof USED>();
  let isClosed = false;
  let dropped = 0;
  const ptys = createGuestPtys({ clock, logger, box, wire });
  const opListeners = new Set<(result: OpResult) => void>();
  let markClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  const giveUp = (entry: Slot, error: Error): void => {
    if (entry.state !== "asked") return;
    entry.state = "used";
    if (entry.timer) clock.clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.reject(error);
  };
  const signal = (slot: string, name: "SIGTERM" | "SIGKILL"): void => {
    wire.send({ type: "signal", slot, signal: name } satisfies GuestCommand);
  };
  /** AVM-E10: a worker hello refused here burns its slot: the worker is killed and the spawn fails, no retry can hang it. */
  const burn = (slot: string, entry: Slot): void => {
    signal(slot, "SIGKILL");
    giveUp(entry, new PapError("worker_failed"));
  };

  const link: GuestLink = {
    spawnWorker(input, packages) {
      if (isClosed) return Promise.reject(new PapError("worker_failed"));
      if (input.sessionFile !== null && !SessionFileName.safeParse(input.sessionFile).success) {
        return Promise.reject(new PapError("bad_request"));
      }
      const slot = randomBytes(16).toString("hex");
      return new Promise<VmWorkerHandle>((resolve, reject) => {
        const entry: Slot = { state: "asked", input, resolve, reject, timer: undefined };
        entry.timer = clock.setTimeout(() => {
          logger.warn("agent_gateway_spawn_timeout", { box });
          signal(slot, "SIGKILL");
          giveUp(entry, new PapError("timeout"));
        }, GUEST_BOOT_TIMEOUT_MS);
        slots.set(slot, entry);
        const sessionFile =
          input.sessionFile === null ? null : `${input.sessionsDir.replace(/\/+$/, "")}/${input.sessionFile}`;
        const command: GuestCommand = {
          type: "spawn",
          slot,
          sessionFile,
          packages,
          ...(input.env ? { env: { ...input.env } } : {}),
        };
        if (!wire.send(command)) giveUp(entry, new PapError("worker_failed"));
      });
    },
    shutdown() {
      wire.send({ type: "shutdown" } satisfies GuestCommand);
    },
    openTerminal: (input) => ptys.open(input),
    sendOp: (id, op) => !isClosed && wire.send({ type: "op", id, op } satisfies GuestCommand),
    onOpResult(listener) {
      opListeners.add(listener);
      return () => void opListeners.delete(listener);
    },
    closed: closedPromise,
  };

  return {
    link,
    acceptWorker(hello, workerWire) {
      const entry = slots.get(hello.slot);
      if (entry === undefined) return "slot";
      if (entry === USED || entry.state !== "asked") return "duplicate";
      // A reopen names its file; a new session names none (its file does not exist yet).
      if (hello.session.file !== entry.input.sessionFile) {
        // A reopen whose worker lacks the recorded file: the launch fails closed, and the owner is told why (AVM-E40 M1).
        if (entry.input.sessionFile !== null) entry.input.lost?.();
        burn(hello.slot, entry);
        return "protocol";
      }
      let mirror: MirrorPort | null = null;
      let worker: VmWorker;
      try {
        if (hello.session.file !== null) {
          const opened = entry.input.mirrorFor(hello.session.file);
          if (opened === "refused") {
            burn(hello.slot, entry);
            return "protocol";
          }
          mirror = opened;
        }
        worker = createVmWorker({
          clock,
          logger,
          label: { box },
          slot: hello.slot,
          input: entry.input,
          wire: workerWire,
          reported: hello.session,
          mirror,
          signal: (name) => signal(hello.slot, name),
        });
      } catch (error) {
        logger.warn("agent_gateway_worker_failed", { box, err: error });
        mirror?.close();
        burn(hello.slot, entry);
        return "protocol";
      }
      // Used only now that the worker exists: a throw above leaves the slot to `burn`, never half taken.
      entry.state = "used";
      if (entry.timer) clock.clearTimeout(entry.timer);
      entry.timer = undefined;
      entry.worker = worker;
      entry.wire = workerWire;
      void worker.handle.exited.then(() => slots.set(hello.slot, USED));
      entry.resolve(worker.handle);
      return { frame: (raw) => worker.receive(raw), closed: () => worker.wireClosed() };
    },
    acceptTerminal: (hello, terminalWire) => ptys.accept(hello, terminalWire),
    frame(raw) {
      const report = GuestReport.safeParse(raw);
      if (!report.success) {
        dropped++;
        if (worthLogging(dropped)) logger.warn("agent_gateway_report_dropped", { box, dropped });
        return;
      }
      if (report.data.type === "op_result") {
        for (const listener of [...opListeners]) listener(report.data);
        return;
      }
      if (report.data.type !== "exited") return;
      if (ptys.refused(report.data.slot, report.data.tail)) return;
      const entry = slots.get(report.data.slot);
      if (entry === undefined || entry === USED) return;
      const { code, signal: name, tail } = report.data;
      if (entry.worker) entry.worker.guestExited(classifyExit(code, name as NodeJS.Signals | null), tail);
      else giveUp(entry, new PapError("worker_failed"));
      slots.set(report.data.slot, USED);
    },
    closed() {
      if (isClosed) return;
      isClosed = true;
      ptys.closed();
      for (const entry of slots.values()) {
        if (entry === USED) continue;
        entry.worker?.guestGone();
        giveUp(entry, new PapError("worker_failed"));
        entry.wire?.close();
      }
      markClosed();
    },
  };
}
