import { beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { laneSnapshot, laneView } from "../testing/lane-fixtures.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { feedLanes, retryLanes } from "./lane-feed.ts";
import { useLaneStore } from "./lane-store.ts";

beforeEach(() => useLaneStore.getState().reset());

describe("feedLanes", () => {
  it("subscribes once, with no key, and applies the events", async () => {
    const bed = fakeRuntime();
    feedLanes(bed.runtime.subscriptions);
    await flush();
    expect(bed.called("subscribe.lane")).toHaveLength(1);
    expect(bed.called("subscribe.lane")[0]?.params).toEqual({});
    bed.emitTo("subscribe.lane", laneSnapshot([laneView({ id: "a-1a2b" })]));
    expect([...useLaneStore.getState().view.lanes.keys()]).toEqual(["a-1a2b"]);
  });

  it("a refused subscription reaches onError", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.lane"] = () => {
      throw new RpcError("capacity");
    };
    const onError = vi.fn();
    feedLanes(bed.runtime.subscriptions, onError);
    await flush();
    expect(onError).toHaveBeenCalledExactlyOnceWith("capacity");
  });

  it("reset (sign-out) empties the store", () => {
    useLaneStore.getState().apply(laneSnapshot([laneView({ id: "a-1a2b" })], [], 2));
    useLaneStore.getState().reset();
    expect(useLaneStore.getState().view).toMatchObject({ loaded: false, archived: 0 });
    expect(useLaneStore.getState().view.lanes.size).toBe(0);
  });
});

describe("lane stream failure", () => {
  it("a refused subscription sets failed; Retry resubscribes; a snapshot clears it", async () => {
    const bed = fakeRuntime();
    let refuse = true;
    bed.handlers["subscribe.lane"] = () => {
      if (refuse) throw new RpcError("capacity");
      return { sub: "ok" };
    };
    feedLanes(bed.runtime.subscriptions);
    await flush();
    expect(useLaneStore.getState().view.failed).toBe("capacity");
    refuse = false;
    retryLanes(bed.runtime.subscriptions);
    await flush();
    expect(bed.called("subscribe.lane")).toHaveLength(2);
    useLaneStore.getState().apply(laneSnapshot([]));
    expect(useLaneStore.getState().view.failed).toBeNull();
  });
});
