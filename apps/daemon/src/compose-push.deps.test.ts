import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PushDeps } from "./modules/push/index.ts";
import { pushDepsOf } from "./modules/push/testing/push-deps.ts";

const seen = vi.hoisted(() => ({ transport: null as unknown, delivery: null as unknown }));

vi.mock("./compose-push-transport.ts", () => ({
  composeTransportSide: (deps: unknown) => {
    seen.transport = deps;
    return { rpc: {}, transport: {}, subscriptions: {}, sessionLive: {} };
  },
}));
vi.mock("./compose-push-delivery.ts", () => ({
  composeDeliverySide: (deps: unknown) => {
    seen.delivery = deps;
    return { rpc: {} };
  },
}));
vi.mock("./modules/push/index.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./modules/push/index.ts")>()),
  pushRpc: () => ({}),
}));

describe("composePush hands the daemon's hub and audit port to both sides (W6-R1)", () => {
  beforeEach(() => {
    seen.transport = null;
    seen.delivery = null;
  });

  it("passes the very objects it was given", async () => {
    const { composePush } = await import("./compose-push.ts");
    const hub = { publish: vi.fn(), registerSnapshot: vi.fn() };
    const audit = { port: { append: vi.fn(), reserve: vi.fn() } };
    const deps = pushDepsOf({ config: { testPushLoopback: false }, hub, audit });
    composePush(deps);
    for (const side of [seen.transport, seen.delivery] as PushDeps[]) {
      expect(side.hub).toBe(hub);
      expect(side.audit).toBe(audit);
    }
  });
});
