import {
  MAX_FRAME_BYTES,
  methods,
  ResponseFrame,
  type ErrorCode,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@pap/contracts";
import type { Connection, Timers } from "./connection.ts";

const PING_EVERY_MS = 5_000;
const encoder = new TextEncoder();

/** What fails before an answer exists: `offline` (nothing was sent), `connection_lost`, `payload_too_large`. */
export type ClientErrorCode = "offline" | "connection_lost" | "payload_too_large";
export type RpcErrorCode = ErrorCode | ClientErrorCode;

type Answer =
  { readonly id: number; readonly result: unknown } | { readonly id: number; readonly code: string };

// A daemon upgraded without a protocol bump may send a code this build has no name for. The call must
// still settle (R123), so anything with an id and `ok: false` is an error, and the code passes through.
function answerOf(frame: unknown): Answer | null {
  const parsed = ResponseFrame.safeParse(frame);
  if (parsed.success) {
    return parsed.data.ok
      ? { id: parsed.data.id, result: parsed.data.result }
      : { id: parsed.data.id, code: parsed.data.error.code };
  }
  const raw = frame as { id?: unknown; ok?: unknown; error?: { code?: unknown } | null } | null;
  if (typeof raw?.id !== "number" || raw.ok !== false) return null;
  const code = raw.error?.code;
  return { id: raw.id, code: typeof code === "string" ? code : "internal" };
}

/**
 * A failed call. `code` is a server error code or one of the client's own: `offline` (nothing was
 * sent), `connection_lost` (sent, no answer) and `payload_too_large` (refused before sending). On a
 * mutation, `connection_lost` and the server's `timeout` both mean "outcome unknown" (R105): the call is
 * never sent again by this client, and the caller reads the state before it tries again.
 */
export class RpcError extends Error {
  readonly code: RpcErrorCode;

  constructor(code: RpcErrorCode) {
    super(code);
    this.name = "RpcError";
    this.code = code;
  }
}

export interface CallOptions {
  /** A mutation sent again as the same intent (R124): the server's receipt for this id answers instead of running it twice. Reads ignore it. */
  readonly commandId?: string;
}

export interface RpcClient {
  call<M extends MethodName>(method: M, params: ParamsOf<M>, options?: CallOptions): Promise<ResultOf<M>>;
  newCommandId(): string;
}

export function createRpcClient(
  connection: Connection,
  deps: { newCommandId(): string; timers: Timers },
): RpcClient {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let ping: number | null = null;

  const client: RpcClient = {
    newCommandId: deps.newCommandId,
    call(method, params, options) {
      if (connection.state !== "open") return Promise.reject(new RpcError("offline"));
      const id = nextId++;
      const frame = {
        id,
        method,
        params,
        ...(methods[method].idempotent ? {} : { commandId: options?.commandId ?? deps.newCommandId() }),
      };
      if (encoder.encode(JSON.stringify(frame)).length > MAX_FRAME_BYTES) {
        return Promise.reject(new RpcError("payload_too_large"));
      }
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
        if (!connection.send(frame)) {
          pending.delete(id);
          reject(new RpcError("offline"));
        }
      });
    },
  };

  const schedulePing = () => {
    ping = deps.timers.set(() => {
      void client.call("system.ping", {}).catch(() => undefined);
      schedulePing();
    }, PING_EVERY_MS);
  };

  if (connection.state === "open") schedulePing();
  connection.onFrame((frame) => {
    const answer = answerOf(frame);
    const entry = answer ? pending.get(answer.id) : undefined;
    if (!answer || !entry) return;
    pending.delete(answer.id);
    if ("code" in answer) entry.reject(new RpcError(answer.code as RpcErrorCode));
    else entry.resolve(answer.result);
  });
  connection.onState((state) => {
    if (state === "open") {
      schedulePing();
      return;
    }
    if (ping !== null) deps.timers.clear(ping);
    ping = null;
    for (const entry of pending.values()) entry.reject(new RpcError("connection_lost"));
    pending.clear();
  });
  return client;
}
