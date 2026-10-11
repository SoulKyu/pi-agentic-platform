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
let detach: (() => void) | null = null;

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
  const onOnline = () => connection.nudge();
  const onVisible = () => {
    if (document.visibilityState === "visible") connection.nudge();
  };
  window.addEventListener("online", onOnline);
  document.addEventListener("visibilitychange", onVisible);
  detach = () => {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    connection.stop();
  };
  runtime = { connection, rpc, subscriptions };
  return runtime;
}

/** Closes the socket and the page listeners of the runtime; the next `getRuntime()` builds a fresh one. */
export function stopRuntime(): void {
  detach?.();
  detach = null;
  runtime = null;
}

// A hot update replaces this module: without this the old runtime keeps its socket and its timers alive
// beside the new one (R125).
if (import.meta.hot) import.meta.hot.dispose(stopRuntime);

export { getJson, postJson } from "./http.ts";
export { RpcError, type RpcErrorCode } from "./rpc.ts";
export { useConnectionState } from "./use-connection-state.ts";
