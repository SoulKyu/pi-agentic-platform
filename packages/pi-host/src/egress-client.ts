import type { EgressOpened, EgressReport } from "@pap/contracts";
import type { Outbound } from "./ipc.ts";
import type { ShellTimers } from "./sandbox-ops.ts";

/** How long the worker waits for the daemon's answer before a command runs without network, or without a report (M11R232). */
const ANSWER_MS = 2000;
/** The daemon's own per-session cap (`commandsPerSession`): the ninth command in flight gets no socket. */
const MAX_IN_FLIGHT = 8;
/** Reports no `tool_result` took (a call that never reached its result): the oldest goes first. */
const MAX_KEPT = 256;

export interface EgressGrant {
  readonly id: string;
  readonly socket: string;
}

/** The worker's end of the egress records (M11R232): ids from a counter, answers matched by id, reports kept by tool call id. */
export function createEgressClient(send: (record: Outbound) => boolean, timers: ShellTimers) {
  let counter = 0;
  const live = new Set<string>();
  const opening = new Map<string, (answer: EgressOpened) => void>();
  const closing = new Map<string, (report: EgressReport) => void>();
  const kept = new Map<string, EgressReport | null>();
  const wait = <T>(table: Map<string, (answer: T) => void>, id: string): Promise<T | null> =>
    new Promise((resolve) => {
      const handle = timers.setTimeout(() => {
        table.delete(id);
        resolve(null);
      }, ANSWER_MS);
      table.set(id, (answer) => {
        timers.clearTimeout(handle);
        table.delete(id);
        resolve(answer);
      });
    });
  return {
    /** A socket for the next networked command, or null: refused, no answer in 2 s, too many in flight, no channel. */
    async open(): Promise<EgressGrant | null> {
      if (live.size >= MAX_IN_FLIGHT) return null;
      const id = `c${++counter}`;
      live.add(id);
      if (!send({ type: "egress_open", id })) {
        live.delete(id);
        return null;
      }
      const answer = await wait(opening, id);
      if (answer?.socket) return { id, socket: answer.socket };
      live.delete(id);
      // No answer: the daemon may have opened it just now. A close lets it free the listener; its report is dropped.
      if (answer === null) send({ type: "egress_close", id });
      return null;
    },
    /** The command ended: its report, or null when none came in 2 s. */
    async close(id: string): Promise<EgressReport | null> {
      live.delete(id);
      return send({ type: "egress_close", id }) ? wait(closing, id) : null;
    },
    opened: (record: EgressOpened): void => opening.get(record.id)?.(record),
    report: (record: EgressReport): void => closing.get(record.id)?.(record),
    keep(toolCallId: string, report: EgressReport | null): void {
      // A second report for an id whose first one nobody took is ambiguous: neither is trusted, the call taints.
      const ambiguous = kept.has(toolCallId);
      kept.delete(toolCallId);
      if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value as string);
      kept.set(toolCallId, ambiguous ? null : report);
    },
    /** The report of a tool call, once; undefined when none was kept (the caller taints). */
    take(toolCallId: string): EgressReport | null | undefined {
      const report = kept.get(toolCallId);
      kept.delete(toolCallId);
      return report;
    },
  };
}
export type EgressClient = ReturnType<typeof createEgressClient>;
