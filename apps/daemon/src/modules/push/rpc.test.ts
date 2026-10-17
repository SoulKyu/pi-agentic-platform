import { type Caller, type HandlerContext, type HandlerTable, type MethodName } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { createReceiptStore } from "../../kernel/db/receipts.ts";
import { createDispatcher } from "../../kernel/ws/dispatcher.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { deliveryRpc } from "./delivery/rpc.ts";
import { pushRpc } from "./rpc.ts";
import { createPushMeta } from "./transport/meta.ts";
import { transportRpc } from "./transport/rpc.ts";
import { createTransportService } from "./transport/service.ts";
import { fakeAudit, openTransportBed } from "./testing/transport-bed.ts";

const ID = "abcdefghijklmnopqrstuv";
const PARAMS: Record<string, unknown> = {
  "push.config": {},
  "push.subscribe": {
    subscription: {
      endpoint: "https://push.example.net/send/abcdefgh",
      keys: { p256dh: "A".repeat(87), auth: "b".repeat(22) },
      locale: "en",
      label: "Phone",
    },
  },
  "push.list": {},
  "push.revoke": { id: "sub-1" },
  "push.test": {},
  "push.presence": { focused: true },
  "push.open": { id: ID },
};
const METHODS = Object.keys(PARAMS) as MethodName[];

function setup() {
  const bed = openTransportBed();
  const service = createTransportService({
    store: bed.store,
    meta: createPushMeta(bed.db),
    transport: { status: () => ({ on: false, reason: null, publicKey: null }) },
    readiness: { publicOrigin: "https://pap.example.net", tls: false, insecureHttp: false },
    clock: bed.clock,
    audit: fakeAudit(),
    logger: silentLogger,
    readOnly: false,
  });
  const dispatch = createDispatcher({
    handlers: pushRpc(transportRpc(service), deliveryRpc()) as unknown as HandlerTable,
    receipts: createReceiptStore(bed.db, createFakeClock()),
    logger: silentLogger,
  });
  let frame = 0;
  const call = (method: string, caller: Caller = testCaller()) => {
    const ctx: HandlerContext = {
      caller,
      connectionId: "c1",
      openSubscription: () => "sub",
      closeSubscription: () => {},
    };
    return dispatch({ id: ++frame, method, params: PARAMS[method], commandId: `c-${frame}` }, ctx);
  };
  return { call, table: pushRpc(transportRpc(service), deliveryRpc()), close: () => bed.close() };
}

describe("the push RPC table", () => {
  it("answers every one of the seven methods", () => {
    const { close, table } = setup();
    expect(Object.keys(table).sort()).toEqual([...METHODS].sort());
    close();
  });

  it("refuses a token with forbidden on every method, push.config included (M12R10)", async () => {
    const { call, close } = setup();
    const token = testCaller({ kind: "token", credentialId: "tok-1" });
    for (const method of METHODS) {
      expect(await call(method, token), method).toMatchObject({ ok: false, error: { code: "forbidden" } });
    }
    close();
  });

  // A delivery service that is not given fails closed (the composition always gives them): the real behaviour is in delivery/rpc.test.ts
  it("answers push_unavailable to a browser session when the delivery services are not given", async () => {
    const { call, close } = setup();
    for (const method of ["push.test", "push.presence", "push.open"]) {
      expect(await call(method), method).toMatchObject({ ok: false, error: { code: "push_unavailable" } });
    }
    close();
  });
});
