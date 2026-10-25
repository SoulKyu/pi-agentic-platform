import { beforeEach, describe, expect, it } from "vitest";
import { RpcError } from "../runtime/rpc.ts";
import { flush } from "../testing/dom.ts";
import { fakeRuntime } from "../testing/runtime-bed.ts";
import { feedLaunches } from "./launch-feed.ts";
import { useLaunchStore } from "./launch-store.ts";

beforeEach(() => useLaunchStore.getState().reset());

describe("feedLaunches", () => {
  it("applies the events of the launches stream", async () => {
    const bed = fakeRuntime();
    feedLaunches(bed.runtime.subscriptions);
    await flush();
    bed.emitTo("subscribe.launches", {
      kind: "snapshot",
      launches: [],
      helpers: { active: 2, max: 4, waiting: 1 },
    });
    expect(useLaunchStore.getState().view.helpers).toEqual({ active: 2, max: 4, waiting: 1 });
  });

  it("ignores a refusal: a daemon without the stream leaves the store empty", async () => {
    const bed = fakeRuntime();
    bed.handlers["subscribe.launches"] = () => {
      throw new RpcError("not_found");
    };
    feedLaunches(bed.runtime.subscriptions);
    await flush();
    expect(useLaunchStore.getState().view.launches.size).toBe(0);
  });
});
