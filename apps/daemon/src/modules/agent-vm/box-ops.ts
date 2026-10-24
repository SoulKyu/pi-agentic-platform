import { randomBytes } from "node:crypto";
import {
  BOX_OP_LIMITS,
  BOX_OP_RESULTS,
  BOX_OP_TIMEOUTS,
  type BoxOpArgs,
  type BoxOpName,
  type BoxOpValue,
  type ErrorCode,
  PapError,
} from "@pap/contracts";
import type { BoxOps } from "../../kernel/boxes.ts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import type { GuestLink, OpResult } from "./guest-link.ts";
import type { AgentRuntime } from "./runtime.ts";

interface Pending {
  readonly settle: (result: OpResult | PapError) => void;
}

/** What one guest link has in flight: one listener for the link, whatever the number of calls. */
interface LinkState {
  readonly pending: Map<string, Pending>;
}

const CODES: Readonly<Record<string, ErrorCode>> = { failed: "worker_failed" };
const codeOf = (code: string): ErrorCode => CODES[code] ?? (code as ErrorCode);

/**
 * The daemon's end of the guest operations (spec boxes). A box that is not running answers `box_stopped` without sending
 * (a call never starts the VM); at most `BOX_OP_LIMITS.inFlight` calls wait on one box (`capacity` above); a call that is not
 * answered in `timeoutMs` on the clock is `timeout`; the guest's answer is matched by id and checked against the operation's
 * result schema; a link that closes fails every call waiting on it with `box_stopped`.
 */
export function createBoxOps(
  runtime: Pick<AgentRuntime, "phase" | "link"> & Partial<Pick<AgentRuntime, "touch">>,
  clock: Clock,
): BoxOps {
  const links = new WeakMap<GuestLink, LinkState>();

  const stateOf = (link: GuestLink): LinkState => {
    const known = links.get(link);
    if (known) return known;
    const state: LinkState = { pending: new Map() };
    links.set(link, state);
    const off = link.onOpResult((result) => {
      const waiting = state.pending.get(result.id);
      if (waiting) waiting.settle(result);
    });
    void link.closed.then(() => {
      off();
      for (const waiting of [...state.pending.values()]) waiting.settle(new PapError("box_stopped"));
    });
    return state;
  };

  function run<N extends BoxOpName>(
    projectId: string,
    op: BoxOpArgs<N>,
    signal: AbortSignal | undefined,
    keepsAlive: boolean,
  ): Promise<BoxOpValue<N>> {
    const box = { kind: "project", id: projectId } as const;
    const link = runtime.phase(box) === "running" ? runtime.link(box) : undefined;
    if (link === undefined) return Promise.reject(new PapError("box_stopped"));
    const state = stateOf(link);
    if (state.pending.size >= BOX_OP_LIMITS.inFlight) return Promise.reject(new PapError("capacity"));
    if (signal?.aborted) return Promise.reject(new PapError("timeout"));
    if (keepsAlive) runtime.touch?.(box);
    const id = randomBytes(16).toString("hex");
    return new Promise<BoxOpValue<N>>((resolve, reject) => {
      const settle = (result: OpResult | PapError): void => {
        if (!state.pending.delete(id)) return;
        clock.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (result instanceof PapError) return reject(result);
        if (!result.ok) return reject(new PapError(codeOf(result.code)));
        const value = BOX_OP_RESULTS[op.name].safeParse(result.value);
        // The guest is the agent's side of the wire: a value that is not the operation's is a broken guest, never trusted.
        if (value.success) resolve(value.data as BoxOpValue<N>);
        else reject(new PapError("worker_failed"));
      };
      const onAbort = (): void => settle(new PapError("timeout"));
      state.pending.set(id, { settle });
      const timer: TimerHandle = clock.setTimeout(
        () => settle(new PapError("timeout")),
        BOX_OP_TIMEOUTS[op.name],
      );
      signal?.addEventListener("abort", onAbort, { once: true });
      if (!link.sendOp(id, op)) settle(new PapError("box_stopped"));
    });
  }

  return {
    call: (projectId, op, signal) => run(projectId, op, signal, true),
    poll: (projectId, op, signal) => run(projectId, op, signal, false),
  };
}
