import {
  methods,
  PapError,
  type ErrorCode,
  type HandlerContext,
  type HandlerTable,
  type MethodDef,
  type RequestFrame,
  type ResponseFrame,
} from "@pap/contracts";
import { isReadOnlyError } from "../db/read-only.ts";
import type { ReceiptStore } from "../db/receipts.ts";
import { sha256Hex } from "../ids.ts";
import type { Logger } from "../logger.ts";

export type Dispatch = (frame: RequestFrame, ctx: HandlerContext) => Promise<ResponseFrame>;
type AnyHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

// What a receipt holds: the result plus the hash of the params it answered, so a reused commandId
// can only ever replay the request it was minted for (R69).
interface ReceiptBody {
  readonly paramsHash: string;
  readonly result: unknown;
}

interface Inflight {
  readonly method: string;
  readonly paramsHash: string;
  readonly response: Promise<ResponseFrame>;
}

const ok = (id: number, result: unknown): ResponseFrame => ({ id, ok: true, result });
const fail = (id: number, code: ErrorCode): ResponseFrame => ({ id, ok: false, error: { code } });

/** JSON with object keys sorted at every depth, so equal params always serialise to the same text. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${members.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") return code;
  return error instanceof Error ? error.name : "unknown";
}

function readReceipt(stored: unknown): ReceiptBody {
  const body = stored as Partial<ReceiptBody> | null;
  if (typeof body !== "object" || body === null || typeof body.paramsHash !== "string") {
    throw new Error("malformed receipt");
  }
  return { paramsHash: body.paramsHash, result: body.result };
}

export function createDispatcher(options: {
  handlers: HandlerTable;
  receipts: ReceiptStore;
  logger: Logger;
}): Dispatch {
  const catalogue = methods as unknown as Record<string, MethodDef>;
  const handlers = options.handlers as unknown as Record<string, AnyHandler>;
  const inflight = new Map<string, Inflight>();

  async function run(
    id: number,
    def: MethodDef,
    params: unknown,
    ctx: HandlerContext,
    receipt: { commandId: string; paramsHash: string } | null,
  ): Promise<ResponseFrame> {
    let result: unknown;
    try {
      const handler = handlers[def.name];
      if (!handler) return fail(id, "unknown_method");
      result = def.result.parse(await handler(params, ctx)) as unknown;
    } catch (error) {
      if (error instanceof PapError) return fail(id, error.code);
      if (isReadOnlyError(error)) return fail(id, "read_only");
      options.logger.error("rpc_handler_failed", { method: def.name, err: error });
      return fail(id, "internal");
    }
    if (receipt)
      remember(ctx.caller.userId, receipt.commandId, def.name, { paramsHash: receipt.paramsHash, result });
    return ok(id, result);
  }

  // The effect has already happened: failing the response now would make the client retry the same
  // commandId and run it again. So a failed save is logged (code only) and the result still goes out.
  function remember(userId: string, commandId: string, method: string, body: ReceiptBody): void {
    try {
      options.receipts.save(userId, commandId, method, body);
    } catch (error) {
      options.logger.error("receipt_save_failed", { method, code: errorCode(error) });
    }
  }

  async function mutate(
    frame: RequestFrame,
    commandId: string,
    def: MethodDef,
    params: unknown,
    ctx: HandlerContext,
  ): Promise<ResponseFrame> {
    const paramsHash = sha256Hex(canonicalJson(params));
    const userId = ctx.caller.userId;
    const stored = options.receipts.find(userId, commandId);
    if (stored) {
      const receipt = readReceipt(stored.result);
      const sameRequest = stored.method === frame.method && receipt.paramsHash === paramsHash;
      return sameRequest ? ok(frame.id, receipt.result) : fail(frame.id, "bad_request");
    }
    // A mutation could not be recorded: refuse it before its handler gets to produce a side effect.
    if (options.receipts.readOnly) return fail(frame.id, "read_only");
    const key = JSON.stringify([userId, commandId]);
    const running = inflight.get(key);
    if (running) {
      if (running.method !== frame.method || running.paramsHash !== paramsHash)
        return fail(frame.id, "bad_request");
      return { ...(await running.response), id: frame.id };
    }
    const response = run(frame.id, def, params, ctx, { commandId, paramsHash });
    inflight.set(key, { method: frame.method, paramsHash, response });
    try {
      return await response;
    } finally {
      inflight.delete(key);
    }
  }

  async function dispatch(frame: RequestFrame, ctx: HandlerContext): Promise<ResponseFrame> {
    if (!Object.hasOwn(catalogue, frame.method)) return fail(frame.id, "unknown_method");
    const def = catalogue[frame.method] as MethodDef;
    if (!ctx.caller.permissions.has(def.permission)) return fail(frame.id, "forbidden");
    const params = def.params.safeParse(frame.params ?? {});
    if (!params.success) return fail(frame.id, "bad_request");
    if (def.idempotent) return run(frame.id, def, params.data, ctx, null);
    if (!frame.commandId) return fail(frame.id, "bad_request");
    return mutate(frame, frame.commandId, def, params.data, ctx);
  }

  // One request can never reject: whatever breaks (receipt store, handler, serialisation) becomes an
  // `internal` frame for that request alone, and a log line (R6).
  return async (frame, ctx) => {
    try {
      return await dispatch(frame, ctx);
    } catch (error) {
      options.logger.error("rpc_dispatch_failed", { method: frame.method, err: error });
      return fail(frame.id, "internal");
    }
  };
}
