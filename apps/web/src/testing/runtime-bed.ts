import { vi } from "vitest";
import type { Runtime } from "../runtime/index.ts";
import type { CallOptions, RpcClient } from "../runtime/rpc.ts";
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
  const calls: Array<{ method: string; params: unknown; options?: CallOptions }> = [];
  const handlers: Record<string, Handler> = {};
  let subs = 0;
  const opened: Array<[method: string, sub: string]> = [];
  let seq = 0;
  let commandIds = 0;
  const call = vi.fn(async (method: string, params: unknown, options?: CallOptions) => {
    calls.push({ method, params, ...(options ? { options } : {}) });
    const handler = handlers[method];
    if (handler) return handler(params);
    if (method === "subscribe.session" || method === "subscribe.shell") {
      const sub = `s${++subs}`;
      opened.push([method, sub]);
      return { sub };
    }
    if (method === "sessions.clearQueue") return { steering: [], followUp: [], truncated: false };
    if (method === "sessions.branches") return { leafId: null, points: [], truncated: false };
    if (method === "policy.listRules") return { rules: [], truncated: false };
    return { ok: true };
  });
  const rpc = {
    call,
    newCommandId: () => `bed-cmd-${String(++commandIds).padStart(8, "0")}`,
  } as unknown as RpcClient;
  const subscriptions = createSubscriptions(fake.connection, rpc, { set: () => 0, clear: () => {} });
  const runtime: Runtime = { connection: fake.connection, rpc, subscriptions };
  return {
    runtime,
    fake,
    calls,
    handlers,
    called: (method: string) => calls.filter((entry) => entry.method === method),
    /** An event to the nth sub opened with `method`, as the server would send it. */
    emitTo: (method: "subscribe.session" | "subscribe.shell", event: unknown, nth = 0) => {
      const sub = opened.filter(([opener]) => opener === method)[nth]?.[1];
      if (sub === undefined) throw new Error(`no ${method} sub #${nth} was opened`);
      fake.deliver({ sub, epoch: "e1", seq: seq++, event });
    },
    /** An event of the session stream, as the server's first session sub would send it. */
    emit: (event: unknown) =>
      fake.deliver({
        sub: opened.find(([method]) => method === "subscribe.session")?.[1] ?? "s1",
        epoch: "e1",
        seq: seq++,
        event,
      }),
  };
}
