import {
  collectClientPaths,
  methods,
  PapError,
  type ErrorCode,
  type HandlerContext,
  type HandlerTable,
  type MethodDef,
  type RequestFrame,
  type ResponseFrame,
  type WorkerCounts,
} from "@pap/contracts";
import { isReadOnlyError } from "../db/read-only.ts";
import type { ReceiptStore } from "../db/receipts.ts";
import { sha256Hex } from "../ids.ts";
import type { Logger } from "../logger.ts";
import type { ClientPathGate } from "./client-path-gate.ts";

export type Dispatch = (frame: RequestFrame, ctx: HandlerContext) => Promise<ResponseFrame>;
type AnyHandler = (params: unknown, ctx: HandlerContext) => Promise<unknown>;

// What a receipt holds: the result plus the hash of the params it answered, so a reused commandId
// can only ever replay the request it was minted for (R69).
// A method that returns a secret (`secretResult`) keeps `secret: true` and no result: the value is shown once (M5R68).
type ReceiptBody =
  | { readonly paramsHash: string; readonly result: unknown; readonly secret?: undefined }
  | { readonly paramsHash: string; readonly secret: true };

interface Inflight {
  readonly method: string;
  readonly credentialId: string;
  readonly paramsHash: string;
  readonly response: Promise<ResponseFrame>;
}

const ok = (id: number, result: unknown): ResponseFrame => ({ id, ok: true, result });
const fail = (id: number, code: ErrorCode, workers?: WorkerCounts): ResponseFrame => ({
  id,
  ok: false,
  error: workers ? { code, workers } : { code },
});

/**
 * What a receipt keeps in place of a hash of the params of a `sensitiveParams` method (MC30): a hash of the declared
 * selector fields only, so `state.db` holds nothing to guess a secret from, and a replay still has to name the same
 * target (a provider, a flow and prompt, a revision, a session and dialog).
 */
const selectorHash = (params: unknown, fields: readonly string[]): string => {
  const record = (params ?? {}) as Record<string, unknown>;
  return sha256Hex(canonicalJson(Object.fromEntries(fields.map((field) => [field, record[field]]))));
};

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
  const body = stored as { paramsHash?: unknown; result?: unknown; secret?: unknown } | null;
  if (typeof body !== "object" || body === null || typeof body.paramsHash !== "string") {
    throw new Error("malformed receipt");
  }
  if (body.secret === true) return { paramsHash: body.paramsHash, secret: true };
  return { paramsHash: body.paramsHash, result: body.result };
}

export function createDispatcher(options: {
  handlers: HandlerTable;
  receipts: ReceiptStore;
  logger: Logger;
  /** A member's request carries box paths only; the walk runs after the params parse, before any handler (M14). */
  gate: ClientPathGate;
  /** Once per request, after the answer is known: the method as sent, how long it took, `ok` or the error code (M10R92). */
  onCall?(method: string, durationMs: number, outcome: string): void;
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
      if (error instanceof PapError) return fail(id, error.code, error.workers);
      if (isReadOnlyError(error)) return fail(id, "read_only");
      options.logger.error("rpc_handler_failed", { method: def.name, err: error });
      return fail(id, "internal");
    }
    if (receipt) {
      const body: ReceiptBody = def.secretResult
        ? { paramsHash: receipt.paramsHash, secret: true }
        : { paramsHash: receipt.paramsHash, result };
      remember(ctx.caller.userId, receipt.commandId, def.name, body);
    }
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
    const paramsHash = def.sensitiveParams
      ? selectorHash(params, def.sensitiveParams)
      : sha256Hex(canonicalJson(params));
    const userId = ctx.caller.userId;
    const stored = options.receipts.find(userId, commandId);
    if (stored) {
      const receipt = readReceipt(stored.result);
      const sameRequest = stored.method === frame.method && receipt.paramsHash === paramsHash;
      if (!sameRequest) return fail(frame.id, "bad_request");
      return receipt.secret ? fail(frame.id, "conflict") : ok(frame.id, receipt.result);
    }
    // A mutation could not be recorded: refuse it before its handler gets to produce a side effect.
    if (options.receipts.readOnly) return fail(frame.id, "read_only");
    const key = JSON.stringify([userId, commandId]);
    const running = inflight.get(key);
    if (running) {
      if (running.method !== frame.method || running.paramsHash !== paramsHash)
        return fail(frame.id, "bad_request");
      // The key is the user, not the credential, so a duplicate from another device or token would be handed the
      // first caller's answer, a secret included. Only the credential that started it is answered from it; the
      // others are told the command is taken, and the handler still runs once.
      if (running.credentialId !== ctx.caller.credentialId) return fail(frame.id, "conflict");
      return { ...(await running.response), id: frame.id };
    }
    const response = run(frame.id, def, params, ctx, { commandId, paramsHash });
    inflight.set(key, { method: frame.method, credentialId: ctx.caller.credentialId, paramsHash, response });
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
    const { value: params, paths } = collectClientPaths(() => def.params.safeParse(frame.params ?? {}));
    if (!params.success) return fail(frame.id, "bad_request");
    if (
      !options.gate.allows(ctx.caller.userId, paths, frame.method.startsWith("files.") ? "files" : undefined)
    )
      return fail(frame.id, "forbidden");
    if (def.idempotent) return run(frame.id, def, params.data, ctx, null);
    if (!frame.commandId) return fail(frame.id, "bad_request");
    return mutate(frame, frame.commandId, def, params.data, ctx);
  }

  // One request can never reject: whatever breaks (receipt store, handler, serialisation) becomes an
  // `internal` frame for that request alone, and a log line (R6).
  async function answer(frame: RequestFrame, ctx: HandlerContext): Promise<ResponseFrame> {
    try {
      return await dispatch(frame, ctx);
    } catch (error) {
      options.logger.error("rpc_dispatch_failed", { method: frame.method, err: error });
      return fail(frame.id, "internal");
    }
  }

  return async (frame, ctx) => {
    const started = performance.now();
    const response = await answer(frame, ctx);
    try {
      options.onCall?.(frame.method, performance.now() - started, response.ok ? "ok" : response.error.code);
    } catch (error) {
      options.logger.error("rpc_observer_failed", { method: frame.method, err: error });
    }
    return response;
  };
}
