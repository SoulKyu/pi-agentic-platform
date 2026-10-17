import { beforeEach, describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { usePwa } from "../../stores/pwa.ts";
import { settled } from "../../testing/pwa-env.ts";
import {
  AUTH,
  FakeSubscription,
  OTHER_KEY,
  P256DH,
  SERVER_KEY,
  SERVER_PUBLIC_KEY,
  fakePushEnv,
  manualTimers,
} from "../../testing/push-env.ts";
import { disablePush, enablePush, releaseDevice, type PushDeps } from "./push-client.ts";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
});

const config = (over: Record<string, unknown> = {}) => ({
  publicKey: SERVER_PUBLIC_KEY,
  status: "on",
  reason: null,
  readiness: { status: "ready" },
  subscribed: 0,
  max: 10,
  lastFailure: null,
  keysReset: null,
  ...over,
});

function bed(
  existing: FakeSubscription | null = null,
  answers: Record<string, (p: unknown) => unknown> = {},
) {
  const push = fakePushEnv({}, existing);
  const clock = manualTimers();
  const calls: Array<[string, unknown]> = [];
  const rpc = {
    call: (method: string, params: unknown) => {
      calls.push([method, params]);
      push.log.push(method);
      const answer = answers[method];
      if (answer) {
        try {
          return Promise.resolve(answer(params));
        } catch (error) {
          return Promise.reject(error);
        }
      }
      if (method === "push.config") return Promise.resolve(config());
      if (method === "push.subscribe") return Promise.resolve({ id: "dev1" });
      return Promise.resolve({ ok: true });
    },
  } as unknown as PushDeps["rpc"];
  const deps: PushDeps = { rpc, env: push.env, timers: clock.timers };
  return { ...push, calls, deps, clock };
}

describe("enablePush", () => {
  it("asks the permission, subscribes with the server key and registers keys, locale and a short label", async () => {
    const page = bed();
    usePwa.getState().setNeedsReenable(true);
    const result = await enablePush(page.deps);
    expect(result).toEqual({ ok: true, id: "dev1" });
    expect(page.requestPermission).toHaveBeenCalledTimes(1);
    expect(page.subscribeCalls).toHaveLength(1);
    const options = page.subscribeCalls[0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array };
    expect(options.userVisibleOnly).toBe(true);
    expect([...options.applicationServerKey]).toEqual([...SERVER_KEY]);
    expect(page.calls.find(([method]) => method === "push.subscribe")?.[1]).toEqual({
      subscription: {
        endpoint: "https://push.example.test/abcdef0123456789",
        keys: { p256dh: P256DH, auth: AUTH },
        locale: "fr",
        label: "iPhone",
      },
    });
    expect(usePwa.getState().needsReenable).toBe(false);
  });

  it("asks the permission before any other await, so the click still counts as a gesture", async () => {
    const page = bed();
    const pending = enablePush(page.deps);
    expect(page.requestPermission).toHaveBeenCalledTimes(1);
    expect(page.calls).toEqual([]);
    await pending;
  });

  it("makes no RPC and no subscription when the permission is denied", async () => {
    const page = bed();
    page.requestPermission.mockResolvedValueOnce("denied");
    expect(await enablePush(page.deps)).toEqual({ ok: false, reason: "denied" });
    expect(page.calls).toEqual([]);
    expect(page.subscribeCalls).toEqual([]);
  });

  it("returns the support reason and never asks when the browser cannot do it", async () => {
    const page = bed();
    const env = { ...page.env, support: () => "needs_install_ios" as const };
    expect(await enablePush({ ...page.deps, env })).toEqual({ ok: false, reason: "needs_install_ios" });
    expect(page.requestPermission).not.toHaveBeenCalled();
  });

  it("unsubscribes the browser subscription again when the server is at capacity (no orphan)", async () => {
    const page = bed(null, {
      "push.subscribe": () => {
        throw new RpcError("capacity");
      },
    });
    expect(await enablePush(page.deps)).toEqual({ ok: false, reason: "capacity" });
    expect(page.state.sub).toBeInstanceOf(FakeSubscription);
    expect((page.state.sub as FakeSubscription).unsubscribed).toBe(1);
  });

  it("maps any other server failure to rpc and drops the subscription it just made", async () => {
    const page = bed(null, {
      "push.subscribe": () => {
        throw new RpcError("internal");
      },
    });
    expect(await enablePush(page.deps)).toEqual({ ok: false, reason: "rpc" });
    expect((page.state.sub as FakeSubscription).unsubscribed).toBe(1);
  });

  it("keeps the browser subscription when the server answers rate_limited, so a retry needs no new prompt (T15b carry)", async () => {
    const page = bed(null, {
      "push.subscribe": () => {
        throw new RpcError("rate_limited");
      },
    });
    expect(await enablePush(page.deps)).toEqual({ ok: false, reason: "rpc" });
    expect(page.state.sub).toBeInstanceOf(FakeSubscription);
    expect((page.state.sub as FakeSubscription).unsubscribed).toBe(0);
  });

  it("a retry after rate_limited reuses that subscription and registers it", async () => {
    let limited = true;
    const page = bed(null, {
      "push.subscribe": () => {
        if (limited) throw new RpcError("rate_limited");
        return { id: "dev1" };
      },
    });
    await enablePush(page.deps);
    limited = false;
    expect(await enablePush(page.deps)).toEqual({ ok: true, id: "dev1" });
    expect(page.subscribeCalls).toHaveLength(1);
    expect((page.state.sub as FakeSubscription).unsubscribed).toBe(0);
  });

  it("is refused without a subscription when push is off on the server", async () => {
    const page = bed(null, {
      "push.config": () => config({ status: "off", publicKey: null, reason: "read_only" }),
    });
    expect(await enablePush(page.deps)).toEqual({ ok: false, reason: "refused" });
    expect(page.subscribeCalls).toEqual([]);
  });

  it("replaces a subscription made with another key instead of failing on it", async () => {
    const stale = new FakeSubscription(OTHER_KEY);
    const page = bed(stale);
    expect(await enablePush(page.deps)).toEqual({ ok: true, id: "dev1" });
    expect(stale.unsubscribed).toBe(1);
    expect(page.subscribeCalls).toHaveLength(1);
  });

  it("keeps a subscription that already uses the server key and does not subscribe again", async () => {
    const mine = new FakeSubscription(SERVER_KEY);
    const page = bed(mine);
    expect(await enablePush(page.deps)).toEqual({ ok: true, id: "dev1" });
    expect(mine.unsubscribed).toBe(0);
    expect(page.subscribeCalls).toEqual([]);
  });

  it("shows a failed registration instead of waiting for the worker forever", async () => {
    const page = bed();
    const env = { ...page.env, ready: () => new Promise<never>(() => {}) };
    const pending = enablePush({ ...page.deps, env });
    await settled();
    expect(page.clock.pending()).toEqual([8_000]);
    page.clock.fireNext();
    expect(await pending).toEqual({ ok: false, reason: "no_service_worker" });
    expect(usePwa.getState().registrationFailed).toBe(true);
    expect(page.calls.map(([method]) => method)).toEqual(["push.config"]);
  });

  it("clears its deadline timer once the worker is ready", async () => {
    const page = bed();
    await enablePush(page.deps);
    expect(page.clock.pending()).toEqual([]);
  });
});

describe("disablePush", () => {
  it("revokes first, then unsubscribes", async () => {
    const page = bed(new FakeSubscription());
    await disablePush(page.deps, "dev1");
    expect(page.log).toEqual(["push.revoke", "unsubscribe"]);
    expect(page.calls[0]).toEqual(["push.revoke", { id: "dev1" }]);
  });

  it("says whether the row was revoked", async () => {
    expect(await disablePush(bed(new FakeSubscription()).deps, "dev1")).toBe(true);
    const failing = bed(new FakeSubscription(), {
      "push.revoke": () => {
        throw new RpcError("internal");
      },
    });
    expect(await disablePush(failing.deps, "dev1")).toBe(false);
  });

  it("unsubscribes even when the revoke fails", async () => {
    const page = bed(new FakeSubscription(), {
      "push.revoke": () => {
        throw new RpcError("not_found");
      },
    });
    await disablePush(page.deps, "dev1");
    expect(page.log).toEqual(["push.revoke", "unsubscribe"]);
  });
});

describe("releaseDevice (sign-out)", () => {
  const list = (current: boolean) => () => ({
    items: [
      { id: "other", label: "x", host: "h", createdAt: 1, lastOkAt: null, current: false },
      { id: "mine", label: "x", host: "h", createdAt: 1, lastOkAt: null, current },
    ],
  });

  it("revokes this device's row, then unsubscribes", async () => {
    const page = bed(new FakeSubscription(), { "push.list": list(true) });
    await releaseDevice(page.deps);
    expect(page.log).toEqual(["push.list", "push.revoke", "unsubscribe"]);
    expect(page.calls[1]).toEqual(["push.revoke", { id: "mine" }]);
  });

  it("unsubscribes locally when the list fails or names no current device", async () => {
    const failing = bed(new FakeSubscription(), {
      "push.list": () => {
        throw new RpcError("forbidden");
      },
    });
    await releaseDevice(failing.deps);
    expect(failing.log).toEqual(["push.list", "unsubscribe"]);
    const none = bed(new FakeSubscription(), { "push.list": list(false) });
    await releaseDevice(none.deps);
    expect(none.log).toEqual(["push.list", "unsubscribe"]);
  });

  it("does nothing without a subscription", async () => {
    const page = bed(null);
    await releaseDevice(page.deps);
    expect(page.calls).toEqual([]);
  });
});

describe("enablePush after a revoke (W6-R15)", () => {
  it("a subscription the server revoked is replaced by a new endpoint, which is accepted", async () => {
    const old = new FakeSubscription(SERVER_KEY);
    let refused = true;
    const page = bed(old, {
      "push.subscribe": () => {
        if (refused) {
          refused = false;
          throw new RpcError("push_revoked");
        }
        return { id: "dev2" };
      },
    });
    page.state.permission = "granted";
    expect(await enablePush(page.deps)).toEqual({ ok: true, id: "dev2" });
    expect(old.unsubscribed).toBe(1);
    expect(page.subscribeCalls).toHaveLength(1);
    expect(page.calls.filter(([method]) => method === "push.subscribe")).toHaveLength(2);
    expect(usePwa.getState().needsReenable).toBe(false);
  });
});
