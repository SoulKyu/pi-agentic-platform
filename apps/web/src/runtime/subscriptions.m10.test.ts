import { describe, expect, it } from "vitest";
import { flush, subscriptionBed as setup } from "./testing.ts";

describe("the tasks stream (M10)", () => {
  it("opens with the cursor only: the board is the owner's own, and resumes from its cursor", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("tasks", "me", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.tasks", {}]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 7, event: { kind: "counts" } });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.tasks", { after: { epoch: "e1", seq: 7 } }]);
  });
});

describe("the inbox stream (M10)", () => {
  it("opens with the cursor only: the inbox is the owner's own, and resumes from its cursor", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("inbox", "me", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.inbox", {}]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 4, event: { kind: "counts" } });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.inbox", { after: { epoch: "e1", seq: 4 } }]);
  });
});

describe("the usage stream (M10)", () => {
  it("opens with the cursor only: the stream is the owner's own, and resumes from it", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("usage", "me", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.usage", {}]]);
    fake.deliver({
      sub: "s1",
      epoch: "e1",
      seq: 4,
      event: { kind: "snapshot", limits: [], todayUsd: 0, budgetUsd: null, autoResume: true },
    });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.usage", { after: { epoch: "e1", seq: 4 } }]);
  });
});
