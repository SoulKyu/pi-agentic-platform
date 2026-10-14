import { describe, expect, it } from "vitest";
import { flush, subscriptionBed as setup } from "./testing.ts";

describe("the vcs stream (M8)", () => {
  it("opens with the repository root as the key and resumes from its cursor", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("vcs", "/home/me/repo", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.vcs", { root: "/home/me/repo" }]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 5, event: { kind: "snapshot", status: null } });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual([
      "subscribe.vcs",
      { root: "/home/me/repo", after: { epoch: "e1", seq: 5 } },
    ]);
  });

  it("keeps two roots apart", async () => {
    const { fake, subscriptions } = setup();
    const a: unknown[] = [];
    const b: unknown[] = [];
    subscriptions.subscribe("vcs", "/a", (event) => a.push(event));
    subscriptions.subscribe("vcs", "/b", (event) => b.push(event));
    await flush();
    fake.deliver({ sub: "s2", epoch: "e1", seq: 0, event: "for-b" });
    expect([a, b]).toEqual([[], ["for-b"]]);
  });
});

describe("the terminal stream (M8)", () => {
  it("opens with the cursor only: the list is the owner's own", async () => {
    const { fake, calls, subscriptions } = setup();
    subscriptions.subscribe("terminal", "me", () => {});
    await flush();
    expect(calls).toEqual([["subscribe.terminal", {}]]);
    fake.deliver({ sub: "s1", epoch: "e1", seq: 3, event: { kind: "snapshot", terminals: [] } });
    fake.setState("waiting");
    fake.setState("open");
    await flush();
    expect(calls.at(-1)).toEqual(["subscribe.terminal", { after: { epoch: "e1", seq: 3 } }]);
  });
});
