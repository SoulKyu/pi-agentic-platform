import { PROTOCOL_VERSION } from "@pap/contracts";
import { createConnection, type Connection, type SocketLike, type Timers } from "./connection.ts";
import { probeServer } from "./http.ts";
import { randomId } from "./random-id.ts";
import { createRpcClient, type RpcClient } from "./rpc.ts";
import { createSubscriptions, type Subscriptions } from "./subscriptions.ts";

export interface Runtime {
  readonly connection: Connection;
  readonly rpc: RpcClient;
  readonly subscriptions: Subscriptions;
}

let runtime: Runtime | null = null;

export function getRuntime(): Runtime {
  if (runtime) return runtime;
  const timers: Timers = {
    set: (fn, ms) => window.setTimeout(fn, ms),
    clear: (id) => window.clearTimeout(id),
  };
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  const connection = createConnection({
    url: `${scheme}://${location.host}/ws?proto=${PROTOCOL_VERSION}`,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike,
    probe: probeServer,
    timers,
    random: Math.random,
  });
  const rpc = createRpcClient(connection, { newCommandId: () => randomId(), timers });
  const subscriptions = createSubscriptions(connection, rpc, timers);
  window.addEventListener("online", () => connection.nudge());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") connection.nudge();
  });
  runtime = { connection, rpc, subscriptions };
  return runtime;
}

export type { ConnectionState } from "./connection.ts";
export { getJson, postJson } from "./http.ts";
export { RpcError } from "./rpc.ts";
export { useConnectionState } from "./use-connection-state.ts";
