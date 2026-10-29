import {
  PLATFORM_OP_NAMES,
  type PlatformCallRecord,
  type PlatformOp,
  type PlatformResultRecord,
  type SessionType,
} from "@pap/contracts";
import { type Mock, vi } from "vitest";
import { createFakeClock } from "../../../kernel/clock.ts";
import { captureLogger } from "../../../testing/capture-logger.ts";
import type { AuditPort } from "../../audit/index.ts";
import { createPlatformPort, type PlatformPort } from "../index.ts";

/** Arguments each op accepts. */
export const ARGS: Record<PlatformOp, unknown> = {
  "agent.notify": { text: "done" },
  "agent.approve": { title: "Ship it?" },
  "agent.delegate": { agent: "Scout", task: "look at the logs" },
  "agent.remind": { when: "in 20m", note: "ping" },
  "lane.note": { note: "wip" },
  "secret.request": { name: "API_KEY", reason: "deploy" },
  "network.request": { host: "api.example.com" },
  "subagent.run": { task: "read the file" },
  "preview.start": { name: "site", command: "python3 -m http.server 8000", port: 8000 },
  "preview.stop": { name: "site" },
};

/** A result each op's schema accepts. */
export const RESULTS: Record<PlatformOp, unknown> = {
  "agent.notify": { itemId: "i1" },
  "agent.approve": { approved: true },
  "agent.delegate": { taskId: "t1" },
  "agent.remind": { taskId: "t1", at: 5 },
  "lane.note": {},
  "secret.request": { ref: `secret-ref:${"a".repeat(32)}`, name: "API_KEY", mode: "once" },
  "network.request": { granted: true },
  "subagent.run": { childId: "c1", answer: "ok", clipped: false, tainted: false },
  "preview.start": { id: "a".repeat(32), name: "site", port: 8000, status: "running", reason: null },
  "preview.stop": { stopped: true },
};

export interface BedKind {
  ownerId: string;
  type: SessionType;
  tainted: boolean;
  agentId: string | null;
  autonomous?: boolean;
}

export type AuditLine = Parameters<AuditPort["append"]>[0];

/** The dispatcher over a fake sessions port (rows by id, one-use approvals by session, call and tool). */
export function createDispatchBed(options: { readOnly?: boolean; reserve?: () => boolean } = {}) {
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const kinds = new Map<string, BedKind>();
  const approvals = new Set<string>();
  const audit: AuditLine[] = [];
  const replies: PlatformResultRecord[] = [];
  const reply = (record: PlatformResultRecord): boolean => {
    replies.push(record);
    return true;
  };
  const port: PlatformPort = createPlatformPort({
    sessions: {
      kindOf: (id) => kinds.get(id) ?? null,
      approvedCalls: {
        take: (sessionId, toolCallId, tool) =>
          approvals.delete(JSON.stringify([sessionId, toolCallId, tool])),
      },
    },
    audit: { append: (line) => void audit.push(line), reserve: () => options.reserve?.() ?? true },
    clock,
    logger,
    readOnly: options.readOnly ?? false,
  });
  return {
    clock,
    port,
    lines,
    audit,
    replies,
    reply,
    approvals,
    session(id: string, kind: Partial<BedKind> = {}): void {
      kinds.set(id, { ownerId: "u1", type: "agent-thread", tainted: false, agentId: "atlas-0001", ...kind });
    },
    forget: (id: string): boolean => kinds.delete(id),
    /** The owner's browser answered Allow once for this tool call on the card of this tool. */
    approve: (sessionId: string, toolCallId: string, tool: string): void =>
      void approvals.add(JSON.stringify([sessionId, toolCallId, tool])),
    call(
      sessionId: string,
      record: { id: string; op: PlatformOp } & Partial<Omit<PlatformCallRecord, "type">>,
      via = reply,
    ): void {
      port.onRecord(
        { id: sessionId, ownerId: "u1" },
        { type: "platform_call", toolCallId: "tc1", args: ARGS[record.op], ...record },
        via,
      );
    },
    cancel: (sessionId: string, id: string, via = reply): void =>
      port.onRecord({ id: sessionId, ownerId: "u1" }, { type: "platform_cancel", id }, via),
    /** Lets the microtasks of a handler and its reply run. */
    settle: () => clock.advance(0),
  };
}

export type DispatchBed = ReturnType<typeof createDispatchBed>;

/** The outcome of each answered call, by id: `ok` or the error code. */
export const outcomes = (bed: DispatchBed): Record<string, string> =>
  Object.fromEntries(bed.replies.map((r) => [r.id, r.error ?? "ok"]));

/** A handler for every op except `skip`, each answering a valid result; the spies by op. */
export function registerAll(bed: DispatchBed, skip?: PlatformOp): Record<PlatformOp, Mock> {
  const handlers = {} as Record<PlatformOp, Mock>;
  for (const op of PLATFORM_OP_NAMES) {
    if (op === skip) continue;
    handlers[op] = vi.fn(() => Promise.resolve(RESULTS[op]));
    bed.port.register(op, handlers[op] as never);
  }
  return handlers;
}
