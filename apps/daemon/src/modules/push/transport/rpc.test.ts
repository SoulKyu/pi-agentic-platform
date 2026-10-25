import { type Caller, type HandlerContext, type HandlerTable } from "@pap/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { createReceiptStore } from "../../../kernel/db/receipts.ts";
import { createDispatcher } from "../../../kernel/ws/dispatcher.ts";
import { silentLogger } from "../../../kernel/logger.ts";
import { testCaller } from "../../../testing/caller.ts";
import { deliveryRpc } from "../delivery/rpc.ts";
import { pushRpc } from "../rpc.ts";
import { fakeAudit, openTransportBed, subInput, type TransportBed } from "../testing/transport-bed.ts";
import { createPushMeta } from "./meta.ts";
import { transportRpc } from "./rpc.ts";
import { createTransportService } from "./service.ts";
import { NO_CLIENT_PATHS } from "../../../kernel/ws/client-path-gate.ts";

let bed: TransportBed;
afterEach(() => bed.close());

const METHODS = [
  "push.config",
  "push.subscribe",
  "push.list",
  "push.revoke",
  "push.presence",
  "push.open",
  "push.test",
] as const;
type Method = (typeof METHODS)[number];

function rpcBed() {
  bed = openTransportBed();
  const audit = fakeAudit();
  const service = createTransportService({
    store: bed.store,
    meta: createPushMeta(bed.db),
    transport: { status: () => ({ on: true, reason: null, publicKey: "PUBKEY" }) },
    readiness: { publicOrigin: "https://pap.example.net", tls: false, insecureHttp: false },
    clock: bed.clock,
    audit,
    logger: bed.logger,
    readOnly: false,
  });
  const dispatch = createDispatcher({
    gate: NO_CLIENT_PATHS,
    handlers: pushRpc(transportRpc(service), deliveryRpc()) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, bed.clock),
    logger: silentLogger,
  });
  let frame = 0;
  const call = (method: string, params: unknown, caller: Caller) => {
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: () => "sub",
      closeSubscription: () => {},
    };
    return dispatch({ id: ++frame, method, params, commandId: `c-${frame}` }, ctx);
  };
  return { call, audit };
}

const ID = "abcdefghijklmnopqrstuv";
const validParamsFor = (method: Method): unknown =>
  ({
    "push.config": {},
    "push.subscribe": { subscription: subInput(1) },
    "push.list": {},
    "push.revoke": { id: "sub-1" },
    "push.presence": { focused: true },
    "push.open": { id: ID },
    "push.test": {},
  })[method];

describe("the chain A RPC methods", () => {
  it("a token can neither subscribe, list, revoke nor see the key", async () => {
    const { call, audit } = rpcBed();
    const tokenCaller = testCaller({ kind: "token", credentialId: "tok-1" });
    const browserCaller = testCaller();
    for (const method of METHODS)
      expect(await call(method, validParamsFor(method), tokenCaller), method).toMatchObject({
        ok: false,
        error: { code: "forbidden" },
      });
    expect(bed.store.countFor("u1")).toBe(0);
    expect(audit.rows).toEqual([]);
    expect(await call("push.list", {}, browserCaller)).toMatchObject({ ok: true, result: { items: [] } });
  });

  it("a browser session subscribes, sees the device in the list, and revokes it", async () => {
    const { call } = rpcBed();
    const caller = testCaller({ credentialId: "dev-1" });
    const subscribed = await call("push.subscribe", { subscription: subInput(1) }, caller);
    expect(subscribed).toMatchObject({ ok: true });
    const id = (subscribed as { result: { id: string } }).result.id;
    const listed = await call("push.list", {}, caller);
    expect(listed).toMatchObject({
      ok: true,
      result: { items: [{ id, host: "web.push.apple.com", current: true }] },
    });
    expect(JSON.stringify(listed)).not.toContain("secretpath");
    expect(await call("push.config", {}, caller)).toMatchObject({
      ok: true,
      result: { status: "on", publicKey: "PUBKEY", subscribed: 1, max: 10 },
    });
    expect(await call("push.revoke", { id }, caller)).toMatchObject({ ok: true, result: { ok: true } });
    expect(await call("push.revoke", { id }, caller)).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await call("push.list", {}, caller)).toMatchObject({ ok: true, result: { items: [] } });
  });

  it("maps the store's refusals to their codes", async () => {
    const { call } = rpcBed();
    const caller = testCaller();
    const bad = subInput(1, { endpoint: "https://evil.example/aaaaaaaaaaaaaaa" });
    expect(await call("push.subscribe", { subscription: bad }, caller)).toMatchObject({
      ok: false,
      error: { code: "bad_request" },
    });
    expect(await call("push.subscribe", { subscription: subInput(2) }, caller)).toMatchObject({
      ok: false,
      error: { code: "rate_limited" },
    });
  });
});
