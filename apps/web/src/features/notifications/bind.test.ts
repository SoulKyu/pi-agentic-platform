import { beforeEach, describe, expect, it } from "vitest";
import { RpcError } from "../../runtime/rpc.ts";
import { usePwa } from "../../stores/pwa.ts";
import { settled } from "../../testing/pwa-env.ts";
import {
  FakeSubscription,
  OTHER_KEY,
  SERVER_KEY,
  SERVER_PUBLIC_KEY,
  fakePushEnv,
  manualTimers,
} from "../../testing/push-env.ts";
import { bindPush } from "./bind.ts";
import type { PushDeps } from "./push-client.ts";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
});

const config = (over: Record<string, unknown> = {}) => ({
  publicKey: SERVER_PUBLIC_KEY,
  status: "on",
  reason: null,
  readiness: { status: "ready" },
  subscribed: 1,
  max: 10,
  lastFailure: null,
  keysReset: null,
  ...over,
});

function bed(
  existing: FakeSubscription | null,
  permission: NotificationPermission | null = "granted",
  subscribe: () => unknown = () => ({ id: "dev1" }),
  cfg: () => unknown = () => config(),
) {
  const push = fakePushEnv({}, existing);
  push.state.permission = permission ?? undefined;
  const clock = manualTimers();
  const calls: string[] = [];
  const rpc = {
    call: (method: string) => {
      calls.push(method);
      try {
        if (method === "push.config") return Promise.resolve(cfg());
        if (method === "push.subscribe") return Promise.resolve(subscribe());
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.resolve({ ok: true });
    },
  } as unknown as PushDeps["rpc"];
  return { ...push, calls, clock, deps: { rpc, env: push.env, timers: clock.timers } satisfies PushDeps };
}

describe("bindPush (M12R12)", () => {
  it("rebind.refreshes-credential: the same key calls push.subscribe again", async () => {
    const mine = new FakeSubscription(SERVER_KEY);
    const page = bed(mine);
    expect(await bindPush(page.deps)).toBe("refreshed");
    expect(page.calls).toEqual(["push.config", "push.subscribe"]);
    expect(mine.unsubscribed).toBe(0);
    expect(usePwa.getState().needsReenable).toBe(false);
  });

  it("rebind.key-changed-reenables: another key unsubscribes, flags the store and does not subscribe", async () => {
    const stale = new FakeSubscription(OTHER_KEY);
    const page = bed(stale);
    expect(await bindPush(page.deps)).toBe("needs_reenable");
    expect(stale.unsubscribed).toBe(1);
    expect(usePwa.getState().needsReenable).toBe(true);
    expect(page.calls).toEqual(["push.config"]);
  });

  it("revoke-sticks (W6-R15): a refused refresh drops the browser subscription and asks for a new Enable, without retrying", async () => {
    const revoked = new FakeSubscription(SERVER_KEY);
    const page = bed(revoked, "granted", () => {
      throw new RpcError("push_revoked");
    });
    expect(await bindPush(page.deps)).toBe("needs_reenable");
    expect(revoked.unsubscribed).toBe(1);
    expect(usePwa.getState().needsReenable).toBe(true);
    expect(page.calls).toEqual(["push.config", "push.subscribe"]);
  });

  it("rebind.none-without-permission: no getSubscription and no RPC", async () => {
    for (const permission of ["default", "denied", null] as const) {
      const page = bed(new FakeSubscription(), permission);
      expect(await bindPush(page.deps)).toBe("none");
      expect(page.registration.pushManager.getSubscription).not.toHaveBeenCalled();
      expect(page.calls).toEqual([]);
    }
  });

  it("is none without a subscription, and makes no RPC for it", async () => {
    const page = bed(null);
    expect(await bindPush(page.deps)).toBe("none");
    expect(page.calls).toEqual([]);
  });

  it("never unsubscribes when push is off on the server (unreadable keys, read-only boot)", async () => {
    for (const over of [
      { status: "off", publicKey: null, reason: "keys_unreadable" },
      { status: "off", publicKey: SERVER_PUBLIC_KEY, reason: "read_only" },
      { status: "on", publicKey: null },
    ]) {
      const stale = new FakeSubscription(OTHER_KEY);
      const page = bed(stale, "granted", undefined, () => config(over));
      expect(await bindPush(page.deps), JSON.stringify(over)).toBe("none");
      expect(stale.unsubscribed).toBe(0);
      expect(page.calls).toEqual(["push.config"]);
      expect(usePwa.getState().needsReenable).toBe(false);
    }
  });

  it("leaves the subscription alone when push.config fails", async () => {
    const stale = new FakeSubscription(OTHER_KEY);
    const page = bed(stale, "granted", undefined, () => {
      throw new RpcError("timeout");
    });
    expect(await bindPush(page.deps)).toBe("none");
    expect(stale.unsubscribed).toBe(0);
  });

  it("retries after rate_limited once the 6 s window has passed, so a second device lands", async () => {
    let attempts = 0;
    const page = bed(new FakeSubscription(), "granted", () => {
      if (++attempts === 1) throw new RpcError("rate_limited");
      return { id: "dev2" };
    });
    const pending = bindPush(page.deps);
    await settled();
    expect(page.calls).toEqual(["push.config", "push.subscribe"]);
    expect(page.clock.pending()).toEqual([6_500]);
    page.clock.fireNext();
    expect(await pending).toBe("refreshed");
    expect(page.calls).toEqual(["push.config", "push.subscribe", "push.subscribe"]);
  });

  it("gives up after two retries and leaves the subscription in place", async () => {
    const mine = new FakeSubscription();
    const page = bed(mine, "granted", () => {
      throw new RpcError("rate_limited");
    });
    const pending = bindPush(page.deps);
    for (let i = 0; i < 2; i++) {
      await settled();
      page.clock.fireNext();
    }
    expect(await pending).toBe("none");
    expect(page.calls.filter((call) => call === "push.subscribe")).toHaveLength(3);
    expect(mine.unsubscribed).toBe(0);
  });

  it("does not retry other failures", async () => {
    const page = bed(new FakeSubscription(), "granted", () => {
      throw new RpcError("push_unavailable");
    });
    expect(await bindPush(page.deps)).toBe("none");
    expect(page.calls.filter((call) => call === "push.subscribe")).toHaveLength(1);
  });
});
