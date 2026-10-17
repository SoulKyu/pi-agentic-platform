import {
  PLATFORM_ARGS,
  PLATFORM_OPS,
  PLATFORM_RESULTS,
  type PlatformCallRecord,
  type PlatformError,
  type PlatformOp,
  type PlatformResultRecord,
  platformVerdict,
  type SessionType,
} from "@pap/contracts";
import type { Clock, TimerHandle } from "../../kernel/clock.ts";
import { guardTimer } from "../../kernel/timer-guard.ts";
import { sizeOf } from "../../kernel/json-bytes.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { platformAuditLine } from "./audit-row.ts";
import {
  createRegistry,
  type PlatformContext,
  type PlatformPort,
  PlatformRefusal,
  type PlatformSessionRef,
} from "./registry.ts";

/** Calls one session may have in flight; the next is refused, never queued and never evicting (M11R38). */
export const MAX_IN_FLIGHT = 8;
/** The JSON of a call's arguments: a bigger call is refused before it is parsed (Review Focus 1). */
export const MAX_ARGS_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What the dispatcher reads of the sessions module: the daemon's own record of a session, and its one-use approvals. */
export interface PlatformKind {
  readonly ownerId: string;
  readonly type: SessionType;
  readonly tainted: boolean;
  readonly agentId: string | null;
  /** Owner a6 (ii): trusted autonomy on in the worker's start-time profile and in the registry now. */
  readonly autonomous?: boolean;
}
export interface PlatformSessions {
  /** Read again at every call; null when the session is gone. */
  kindOf(sessionId: string): PlatformKind | null;
  readonly approvedCalls: {
    /** True once for a browser session's Allow once on the card of this tool call and this tool (M11R39). */
    take(sessionId: string, toolCallId: string, tool: string): boolean;
  };
}

export interface PlatformDeps {
  readonly sessions: PlatformSessions;
  readonly audit: Pick<AuditPort, "append" | "reserve">;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The database is one a newer pap wrote: no op runs and nothing is written (M10R150). */
  readonly readOnly: boolean;
}

type Reply = (result: PlatformResultRecord) => unknown;

interface Flight {
  readonly reply: Reply;
  readonly controller: AbortController;
  /** Why the call ends early; set before the signal aborts. */
  forced: PlatformError | null;
}

const errorClassOf = (error: unknown): string =>
  error instanceof Error ? error.constructor.name.slice(0, 64) : "non_error";

/**
 * The dispatcher of the worker's `platform_call` records (M11R38). Caller identity is the session row, read again at
 * each call; steps 1 to 8 below run without an await, so what was checked is what the handler is started under.
 */
export function createPlatformPort(deps: PlatformDeps): PlatformPort {
  const { clock, logger: parent, sessions } = deps;
  const logger = parent.child({ component: "platform" });
  const registry = createRegistry();
  const flights = new Map<string, Map<string, Flight>>();
  let stopped = false;

  /** The call's audit row, written under the slot `reserve` took when the call was admitted (W5-R16). */
  function writeAudit(line: ReturnType<typeof platformAuditLine>): void {
    if (!deps.readOnly) deps.audit.append(line);
  }

  function send(reply: Reply, record: PlatformResultRecord): void {
    try {
      reply(record);
    } catch (error) {
      logger.warn("platform_reply_failed", { errorClass: errorClassOf(error) });
    }
  }

  /** One audit row, then the answer. */
  function finish(
    row: PlatformSessionRef,
    id: string,
    op: PlatformOp | "unknown",
    type: SessionType | null,
    outcome: { readonly result: unknown } | { readonly error: PlatformError },
    reply: Reply,
    relaxed = false,
  ): void {
    const code = "error" in outcome ? outcome.error : "ok";
    writeAudit(platformAuditLine(row, op, type, code, relaxed));
    send(
      reply,
      "error" in outcome
        ? { type: "platform_result", id, ok: false, error: outcome.error }
        : { type: "platform_result", id, ok: true, result: outcome.result },
    );
  }

  function end(flight: Flight, code: PlatformError): void {
    flight.forced ??= code;
    // The code is the signal's reason: an op tells a deadline from a stop (Task 29b).
    flight.controller.abort(code);
  }

  async function run(
    row: PlatformSessionRef,
    record: PlatformCallRecord,
    op: PlatformOp,
    ctx: Omit<PlatformContext, "signal">,
    args: unknown,
    reply: Reply,
    relaxed: boolean,
  ): Promise<void> {
    const entry = registry.get(op);
    if (!entry) return finish(row, record.id, op, ctx.type, { error: "unavailable" }, reply);
    const flight: Flight = { reply, controller: new AbortController(), forced: null };
    const own = flights.get(row.id) ?? new Map<string, Flight>();
    own.set(record.id, flight);
    flights.set(row.id, own);
    const timer: TimerHandle = clock.setTimeout(
      () => void guardTimer(logger, "platform_deadline", () => end(flight, "timeout"), clock),
      PLATFORM_OPS[op].deadlineMs,
    );
    const forced = new Promise<PlatformError>((resolve) => {
      flight.controller.signal.addEventListener("abort", () => resolve(flight.forced ?? "cancelled"), {
        once: true,
      });
    });
    let started: Promise<unknown>;
    try {
      started = Promise.resolve(entry.handler(args as never, { ...ctx, signal: flight.controller.signal }));
    } catch (error) {
      started = Promise.reject(error);
    }
    const settled = await Promise.race([
      started.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      ),
      forced.then((code) => ({ code })),
    ]);
    clock.clearTimeout(timer);
    if (own.get(record.id) === flight) own.delete(record.id);
    if (own.size === 0 && flights.get(row.id) === own) flights.delete(row.id);
    const done = (outcome: { readonly result: unknown } | { readonly error: PlatformError }) =>
      finish(row, record.id, op, ctx.type, outcome, reply, relaxed);
    if ("code" in settled) return done({ error: settled.code });
    if ("error" in settled) {
      if (settled.error instanceof PlatformRefusal) return done({ error: settled.error.code });
      logger.warn("platform_op_failed", { op, errorClass: errorClassOf(settled.error) });
      return done({ error: "internal" });
    }
    const parsed = PLATFORM_RESULTS[op].safeParse(settled.value);
    if (!parsed.success) {
      logger.warn("platform_result_invalid", { op });
      return done({ error: "internal" });
    }
    return done({ result: parsed.data });
  }

  function call(row: PlatformSessionRef, record: PlatformCallRecord, reply: Reply): void {
    const { id } = record;
    if (typeof id !== "string" || !ID.test(id)) {
      logger.warn("platform_call_invalid");
      return;
    }
    // Every call that is not read-only holds one audit slot from here on; none left: nothing runs (W5-R16).
    if (!deps.readOnly && !deps.audit.reserve(row))
      return send(reply, { type: "platform_result", id, ok: false, error: "rate_limited" });
    const opName: unknown = record.op;
    if (typeof opName !== "string" || !Object.hasOwn(PLATFORM_OPS, opName))
      return finish(row, id, "unknown", null, { error: "bad_request" }, reply);
    const op = opName as PlatformOp;
    const refuse = (error: PlatformError, type: SessionType | null = null) =>
      finish(row, id, op, type, { error }, reply);
    // 1. A stopped dispatcher and a read-only database run nothing.
    if (stopped || deps.readOnly) return refuse("unavailable");
    // 2. At most eight in flight for the session; calls of an earlier worker of the session are over.
    const own = flights.get(row.id);
    for (const [flightId, flight] of own ?? []) {
      if (flight.reply === reply) continue;
      own?.delete(flightId);
      end(flight, "cancelled");
    }
    if ((own?.size ?? 0) >= MAX_IN_FLIGHT) return refuse("rate_limited");
    if (own?.has(id)) return refuse("bad_request");
    // 3. The call as the worker sent it must be well formed and small.
    if (
      typeof record.toolCallId !== "string" ||
      record.toolCallId.length < 1 ||
      record.toolCallId.length > 256
    )
      return refuse("bad_request");
    if (sizeOf(record.args) > MAX_ARGS_BYTES) return refuse("bad_request");
    // 4. The caller is the session's row now: its owner, its type and its taint.
    const kind = sessions.kindOf(row.id);
    if (!kind) return refuse("not_found");
    // 5. The type decides first, then the taint; an approval is spent only for a call the type allows.
    const spec = PLATFORM_OPS[op];
    const approvedCall =
      kind.tainted &&
      spec.whenTainted === "ask" &&
      (spec.callers as readonly SessionType[]).includes(kind.type) &&
      sessions.approvedCalls.take(row.id, record.toolCallId, spec.tool);
    const autonomous = kind.autonomous === true;
    const facts = { type: kind.type, tainted: kind.tainted, approvedCall };
    const verdict = platformVerdict(op, { ...facts, autonomous });
    if (verdict) return refuse(verdict, kind.type);
    // Owner a6, M11R219: autonomy alone let this tainted call run (no approval spent for it): it runs now and the same
    // call without autonomy would be refused as tainted. Asked of the verdict itself, never of a copy of its conditions.
    const relaxed = autonomous && platformVerdict(op, { ...facts, autonomous: false }) === "tainted";
    // 6. The arguments, strictly.
    const args = PLATFORM_ARGS[op].safeParse(record.args);
    if (!args.success) return refuse("bad_request", kind.type);
    // 7. A handler, with its switch on for this owner.
    if (!registry.available(op, kind.ownerId)) return refuse("unavailable", kind.type);
    // 8. The handler, under the op's deadline.
    const ctx = {
      ownerId: kind.ownerId,
      sessionId: row.id,
      type: kind.type,
      tainted: kind.tainted,
      agentId: kind.agentId,
    };
    void run({ id: row.id, ownerId: kind.ownerId }, record, op, ctx, args.data, reply, relaxed).catch(
      (error: unknown) => {
        logger.error("platform_dispatch_failed", { op, errorClass: errorClassOf(error) });
        send(reply, { type: "platform_result", id, ok: false, error: "internal" });
      },
    );
  }

  return {
    register: registry.register,
    available: registry.available,
    onRecord(row, record, reply) {
      try {
        if (record.type === "platform_cancel") {
          const flight = flights.get(row.id)?.get(record.id);
          // Only the worker that made the call may cancel it (ids restart at p1 with each worker).
          if (flight?.reply === reply) end(flight, "cancelled");
          return;
        }
        call(row, record, reply);
      } catch (error) {
        logger.error("platform_dispatch_failed", { errorClass: errorClassOf(error) });
        if (record.type === "platform_call" && typeof record.id === "string" && ID.test(record.id))
          send(reply, { type: "platform_result", id: record.id, ok: false, error: "internal" });
      }
    },
    workerEnded(row, reply) {
      for (const flight of [...(flights.get(row.id)?.values() ?? [])])
        if (flight.reply === reply) end(flight, "cancelled");
    },
    stop() {
      stopped = true;
      for (const own of [...flights.values()])
        for (const flight of [...own.values()]) end(flight, "unavailable");
    },
  };
}
