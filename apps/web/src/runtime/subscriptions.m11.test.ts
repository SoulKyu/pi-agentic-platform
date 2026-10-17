import { describe, expect, it } from "vitest";
import { flush, subscriptionBed as setup } from "./testing.ts";

describe("the agents stream (M11R63)", () => {
  it("opens once with the cursor only: the rail is the owner's own, and resumes from its cursor", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("agents", "me", () => {});
    subscriptions.subscribe("agents", "me", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.agents", {}]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 6, event: { kind: "agent_removed", id: "atlas-1a2b" } });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.agents", { after: { epoch: "e1", seq: 6 } }]);
  });
});
