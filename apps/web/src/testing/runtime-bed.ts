import { vi } from "vitest";
import type { Runtime } from "../runtime/index.ts";
import type { RpcClient } from "../runtime/rpc.ts";
import { createSubscriptions } from "../runtime/subscriptions.ts";
import { fakeConnection } from "../runtime/testing.ts";
import type { ConnectionState } from "../runtime/connection.ts";

type Handler = (params: unknown) => unknown;

/**
 * The runtime a screen sees in a test: a fake connection, the real subscriptions on top of it, and an rpc
 * whose answers the test sets per method (`handlers`). Tests hand it out through a `vi.mock` of `getRuntime`.
 */
export function fakeRuntime(state: ConnectionState = "open") {
  const fake = fakeConnection(state);
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers: Record<string, Handler> = {};
  let subs = 0;
  let seq = 0;
  const call = vi.fn(async (method: string, params: unknown) => {
    calls.push({ method, params });
    const handler = handlers[method];
    if (handler) return handler(params);
    if (method === "subscribe.session") return { sub: `s${++subs}` };
    return method === "sessions.list" ? { sessions: [] } : { ok: true };
  });
  const rpc = { call } as unknown as RpcClient;
  const subscriptions = createSubscriptions(fake.connection, rpc, { set: () => 0, clear: () => {} });
  const runtime: Runtime = { connection: fake.connection, rpc, subscriptions };
  return {
    runtime,
    fake,
    calls,
    handlers,
    called: (method: string) => calls.filter((entry) => entry.method === method),
    /** An event of the session stream, as the server's first (and only) sub would send it. */
    emit: (event: unknown) => fake.deliver({ sub: "s1", epoch: "e1", seq: seq++, event }),
  };
}
