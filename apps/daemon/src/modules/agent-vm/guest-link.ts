import { randomBytes } from "node:crypto";
import {
  GUEST_BOOT_TIMEOUT_MS,
  GuestReport,
  type GuestCommand,
  type Hello,
  PapError,
  SessionFileName,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { classifyExit } from "../../kernel/supervisor/exit.ts";
import {
  createVmWorker,
  type MirrorPort,
  type PackagePicks,
  type VmWorkerHandle,
  type VmWorker,
  type Wire,
  type WorkerSpawnInput,
} from "./vm-worker.ts";

export interface GuestLink {
  /** Asks the guest to start a worker; resolves once the worker's hello arrived (`init` is sent after, never dropped). */
  spawnWorker(input: WorkerSpawnInput, packages: PackagePicks): Promise<VmWorkerHandle>;
  shutdown(): void;
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

// Powers of two, like the worker core: a guest that floods garbage cannot flood the log.
const worthLogging = (count: number): boolean => (count & (count - 1)) === 0;

export function createGuestLink(deps: {
  clock: Clock;
  logger: Logger;
  agentId: string;
  wire: Wire;
}): GuestLinkInternals {
  const { clock, logger, agentId, wire } = deps;
  const slots = new Map<string, Slot>();
  let isClosed = false;
  let dropped = 0;
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
          logger.warn("agent_gateway_spawn_timeout", { agentId });
          signal(slot, "SIGKILL");
          giveUp(entry, new PapError("timeout"));
        }, GUEST_BOOT_TIMEOUT_MS);
        slots.set(slot, entry);
        const sessionFile =
          input.sessionFile === null ? null : `${input.sessionsDir.replace(/\/+$/, "")}/${input.sessionFile}`;
        const command: GuestCommand = { type: "spawn", slot, sessionFile, packages };
        if (!wire.send(command)) giveUp(entry, new PapError("worker_failed"));
      });
    },
    shutdown() {
      wire.send({ type: "shutdown" } satisfies GuestCommand);
    },
    closed: closedPromise,
  };

  return {
    link,
    acceptWorker(hello, workerWire) {
      const entry = slots.get(hello.slot);
      if (!entry) return "slot";
      if (entry.state !== "asked") return "duplicate";
      if (entry.input.sessionFile !== null && hello.session.file !== entry.input.sessionFile)
        return "protocol";
      let mirror: MirrorPort | null = null;
      if (hello.session.file !== null) {
        const opened = entry.input.mirrorFor(hello.session.file);
        if (opened === "refused") return "protocol";
        mirror = opened;
      }
      entry.state = "used";
      if (entry.timer) clock.clearTimeout(entry.timer);
      entry.timer = undefined;
      const worker = createVmWorker({
        clock,
        logger,
        label: { agentId },
        input: entry.input,
        wire: workerWire,
        reported: hello.session,
        mirror,
        signal: (name) => signal(hello.slot, name),
      });
      entry.worker = worker;
      entry.wire = workerWire;
      entry.resolve(worker.handle);
      return { frame: (raw) => worker.receive(raw), closed: () => worker.wireClosed() };
    },
    frame(raw) {
      const report = GuestReport.safeParse(raw);
      if (!report.success) {
        dropped++;
        if (worthLogging(dropped)) logger.warn("agent_gateway_report_dropped", { agentId, dropped });
        return;
      }
      if (report.data.type !== "exited") return;
      const entry = slots.get(report.data.slot);
      if (!entry) return;
      const { code, signal: name, tail } = report.data;
      if (entry.worker) entry.worker.guestExited(classifyExit(code, name as NodeJS.Signals | null), tail);
      else giveUp(entry, new PapError("worker_failed"));
    },
    closed() {
      if (isClosed) return;
      isClosed = true;
      for (const entry of slots.values()) {
        giveUp(entry, new PapError("worker_failed"));
        entry.wire?.close();
      }
      markClosed();
    },
  };
}
