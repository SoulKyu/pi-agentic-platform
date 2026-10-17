import { beforeEach, describe, expect, it } from "vitest";
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
import { rebindDevice, resubscribeDevice } from "./start.ts";

beforeEach(() => {
  usePwa.setState(usePwa.getInitialState(), true);
});

const config = {
  publicKey: SERVER_PUBLIC_KEY,
  status: "on",
  reason: null,
  readiness: { status: "ready" },
  subscribed: 0,
  max: 10,
  lastFailure: null,
  keysReset: null,
};

function bed(
  permission: NotificationPermission,
  existing: FakeSubscription | null,
  items: Array<{ id: string; current: boolean }> = [{ id: "dev1", current: true }],
) {
  const push = fakePushEnv({}, existing);
  push.state.permission = permission;
  const calls: string[] = [];
  const rpc = {
    call: (method: string) => {
      calls.push(method);
      if (method === "push.config") return Promise.resolve(config);
      if (method === "push.list") return Promise.resolve({ items });
      if (method === "push.subscribe") return Promise.resolve({ id: "dev1" });
      return Promise.resolve({ ok: true });
    },
  } as never;
  return { ...push, calls, rpc, timers: manualTimers().timers };
}

describe("a resubscribe message (pushsubscriptionchange)", () => {
  it("re-enables silently when the permission is granted: no permission prompt", async () => {
    const page = bed("granted", new FakeSubscription(OTHER_KEY));
    await resubscribeDevice(page.rpc, page.timers, page.env);
    expect(page.requestPermission).not.toHaveBeenCalled();
    expect(page.calls).toEqual(["push.list", "push.config", "push.subscribe"]);
    expect(page.subscribeCalls).toHaveLength(1);
  });

  it("does not enrol a device that has no row (revoked, or signed out): only a click does", async () => {
    for (const items of [[], [{ id: "other", current: false }]]) {
      const page = bed("granted", new FakeSubscription(OTHER_KEY), items);
      await resubscribeDevice(page.rpc, page.timers, page.env);
      expect(page.calls).toEqual(["push.list"]);
      expect(page.subscribeCalls).toHaveLength(0);
    }
  });

  it("does nothing when the permission is not granted", async () => {
    for (const permission of ["default", "denied"] as const) {
      const page = bed(permission, null);
      await resubscribeDevice(page.rpc, page.timers, page.env);
      expect(page.requestPermission).not.toHaveBeenCalled();
      expect(page.calls).toEqual([]);
    }
  });
});

describe("rebindDevice", () => {
  it("binds with the browser's objects", async () => {
    const page = bed("granted", new FakeSubscription(SERVER_KEY));
    await rebindDevice(page.rpc, page.timers, page.env);
    await settled();
    expect(page.calls).toEqual(["push.config", "push.subscribe"]);
  });
});
