import {
  MAX_FRAME_BYTES,
  methods,
  ResponseFrame,
  type MethodName,
  type ParamsOf,
  type ResultOf,
} from "@pap/contracts";
import type { Connection, Timers } from "./connection.ts";

const PING_EVERY_MS = 5_000;
const encoder = new TextEncoder();

/**
 * A failed call. `code` is a server error code or one of the client's own: `offline` (nothing was
 * sent), `connection_lost` (sent, no answer) and `payload_too_large` (refused before sending). On a
 * mutation, `connection_lost` and the server's `timeout` both mean "outcome unknown" (R105): the call is
 * never sent again by this client, and the caller reads the state before it tries again.
 */
export class RpcError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "RpcError";
    this.code = code;
  }
}

export interface RpcClient {
  call<M extends MethodName>(method: M, params: ParamsOf<M>): Promise<ResultOf<M>>;
}

export function createRpcClient(
  connection: Connection,
  deps: { newCommandId(): string; timers: Timers },
): RpcClient {
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let nextId = 1;
  let ping: number | null = null;

  const client: RpcClient = {
    call(method, params) {
      if (connection.state !== "open") return Promise.reject(new RpcError("offline"));
      const id = nextId++;
      const frame = {
        id,
        method,
        params,
        ...(methods[method].idempotent ? {} : { commandId: deps.newCommandId() }),
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
    const parsed = ResponseFrame.safeParse(frame);
    if (!parsed.success) return;
    const entry = pending.get(parsed.data.id);
    if (!entry) return;
    pending.delete(parsed.data.id);
    if (parsed.data.ok) entry.resolve(parsed.data.result);
    else entry.reject(new RpcError(parsed.data.error.code));
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
