import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { limitView, usageRuntime, usageSnapshot } from "../testing/usage-bed.ts";
import { feedUsage } from "./usage-feed.ts";
import { useUsageStore } from "./usage-store.ts";

beforeEach(() => useUsageStore.getState().reset());

describe("feedUsage", () => {
  it("applies the events of the usage stream to the store", async () => {
    const bed = usageRuntime();
    feedUsage(bed.runtime.subscriptions);
    await flush();
    bed.emitUsage(usageSnapshot([limitView({ sessionId: "a" })]));
    expect([...useUsageStore.getState().view.limits.keys()]).toEqual(["a"]);
    bed.emitUsage({ kind: "limit_cleared", sessionId: "a" });
    expect(useUsageStore.getState().view.limits.size).toBe(0);
  });

  it("a refused subscription is kept in the view and told once", async () => {
    const bed = usageRuntime();
    bed.handlers["subscribe.usage"] = () => {
      throw new RpcError("capacity");
    };
    const onError = vi.fn();
    feedUsage(bed.runtime.subscriptions, onError);
    await flush();
    expect(useUsageStore.getState().view.failed).toBe("capacity");
    expect(onError).toHaveBeenCalledExactlyOnceWith("capacity");
  });

  it("reset empties the store (sign-out)", () => {
    useUsageStore.getState().apply(usageSnapshot([limitView()]));
    useUsageStore.getState().reset();
    expect(useUsageStore.getState().view.limits.size).toBe(0);
    expect(useUsageStore.getState().view.loaded).toBe(false);
  });
});
