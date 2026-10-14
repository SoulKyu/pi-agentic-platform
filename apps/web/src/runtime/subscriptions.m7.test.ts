import { describe, expect, it } from "vitest";
import { flush, subscriptionBed as setup } from "./testing.ts";

describe("the login stream (M7 Task 11)", () => {
  it("asks subscribe.login with the flow id as key, and resumes from its cursor", async () => {
    const { fake, calls, subscriptions } = setup();
    const seen: unknown[] = [];
    subscriptions.subscribe("login", "flow-1", (event) => seen.push(event));
    await flush();
    expect(calls).toEqual([["subscribe.login", { flowId: "flow-1" }]]);
    fake.deliver({ sub: "s1", epoch: "e", seq: 2, event: { kind: "snapshot", events: [] } });
    expect(seen).toEqual([{ kind: "snapshot", events: [] }]);
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.login", { flowId: "flow-1", after: { epoch: "e", seq: 2 } }]);
  });
});
