import type {
  PLATFORM_ARGS,
  PLATFORM_RESULTS,
  PlatformCallRecord,
  PlatformCancelRecord,
  PlatformError,
  PlatformOp,
  PlatformResultRecord,
  SessionType,
} from "@pap/contracts";
import type { z } from "zod";

/** What an op's handler knows of its caller: the daemon's own record of the session, read when the call arrived. */
export interface PlatformContext {
  readonly ownerId: string;
  readonly sessionId: string;
  readonly type: SessionType;
  readonly tainted: boolean;
  readonly agentId: string | null;
  /** Aborted by the op's deadline, a `platform_cancel` or the daemon's stop: the handler ends what it started. */
  readonly signal: AbortSignal;
}

export type PlatformHandler<Op extends PlatformOp> = (
  args: z.output<(typeof PLATFORM_ARGS)[Op]>,
  ctx: PlatformContext,
) => Promise<z.input<(typeof PLATFORM_RESULTS)[Op]>>;

/** What a handler throws to answer with a code other than `internal`. */
export class PlatformRefusal extends Error {
  override name = "PlatformRefusal";
  readonly code: PlatformError;
  constructor(code: PlatformError) {
    super(code);
    this.code = code;
  }
}

export interface PlatformRegistration {
  /** The owner's switch for the op (owner m12's "subagents off"): read at every worker start and every call. */
  enabled?(ownerId: string): boolean;
}

/** The session a call comes from, as the sessions module's bridge holds it. */
export interface PlatformSessionRef {
  readonly id: string;
  readonly ownerId: string;
}

export interface PlatformPort {
  register<Op extends PlatformOp>(op: Op, handler: PlatformHandler<Op>, options?: PlatformRegistration): void;
  /** The op has a handler and its switch, if it has one, is on for the owner. */
  available(op: PlatformOp, ownerId: string): boolean;
  /** A `platform_call` or `platform_cancel` of the worker of `row`; `reply` sends a `platform_result` to that worker. */
  onRecord(
    row: PlatformSessionRef,
    record: PlatformCallRecord | z.infer<typeof PlatformCancelRecord>,
    reply: (result: PlatformResultRecord) => unknown,
  ): void;
  /** The worker that sent `reply` is gone: its calls in flight end. */
  workerEnded(row: PlatformSessionRef, reply: (result: PlatformResultRecord) => unknown): void;
  /** No call is accepted from now on (`unavailable`) and the ones in flight end. */
  stop(): void;
}

interface Entry {
  readonly handler: PlatformHandler<PlatformOp>;
  readonly enabled: ((ownerId: string) => boolean) | undefined;
}

export interface Registry {
  register: PlatformPort["register"];
  available: PlatformPort["available"];
  get(op: PlatformOp): Entry | null;
}

export function createRegistry(): Registry {
  const entries = new Map<PlatformOp, Entry>();
  const switchOn = (entry: Entry, ownerId: string): boolean => {
    try {
      return entry.enabled?.(ownerId) ?? true;
    } catch {
      // A switch that cannot be read is off: an op nobody could turn off must not run.
      return false;
    }
  };
  return {
    register(op, handler, options) {
      if (entries.has(op)) throw new Error(`platform op ${op} is already registered`);
      entries.set(op, { handler: handler as PlatformHandler<PlatformOp>, enabled: options?.enabled });
    },
    available(op, ownerId) {
      const entry = entries.get(op);
      return entry !== undefined && switchOn(entry, ownerId);
    },
    get: (op) => entries.get(op) ?? null,
  };
}
