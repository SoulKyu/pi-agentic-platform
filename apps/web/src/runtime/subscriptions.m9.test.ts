import { describe, expect, it } from "vitest";
import { flush, subscriptionBed as setup } from "./testing.ts";

describe("the lane stream (M9)", () => {
  it("opens with the cursor only: the lanes are the owner's own", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("lane", "me", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.lane", {}]]);
    fake.deliver({
      sub: "s1",
      epoch: "e1",
      seq: 4,
      event: { kind: "snapshot", lanes: [], fanouts: [], archived: 0, truncated: false },
    });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.lane", { after: { epoch: "e1", seq: 4 } }]);
  });
});
