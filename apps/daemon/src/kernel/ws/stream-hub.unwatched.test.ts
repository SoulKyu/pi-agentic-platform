import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createStreamHub } from "./stream-hub.ts";

// MC31: a module learns when the last subscriber of a key is gone (a closed tab, a lost connection).
function setup() {
  const hub = createStreamHub("epoch-1", createFakeClock());
  hub.registerSnapshot("login", () => ({ kind: "snapshot" }));
  hub.registerSnapshot("session", () => ({ kind: "snapshot" }));
  const left: string[] = [];
  hub.onLastSubscriberLeft("login", (key) => void left.push(key));
  const open = (connectionId: string, sub: string, key: string, stream: "login" | "session" = "login") =>
    hub.open({ connectionId, sub, stream, key, after: undefined, send: () => {} });
  return { hub, left, open };
}

describe("onLastSubscriberLeft", () => {
  it("fires when the last subscriber of the key closes, not before", () => {
    const { hub, left, open } = setup();
    open("c1", "s1", "flow1");
    open("c2", "s1", "flow1");
    hub.close("c1");
    expect(left).toEqual([]);
    hub.close("c2");
    expect(left).toEqual(["flow1"]);
  });

  it("fires for a connection that ends with several subscriptions, once per key", () => {
    const { hub, left, open } = setup();
    open("c1", "s1", "flow1");
    open("c1", "s2", "flow2");
    hub.close("c1");
    expect(left.sort()).toEqual(["flow1", "flow2"]);
  });

  it("fires for one subscription closed by id", () => {
    const { hub, left, open } = setup();
    open("c1", "s1", "flow1");
    open("c1", "s2", "flow1");
    hub.close("c1", "s1");
    expect(left).toEqual([]);
    hub.close("c1", "s2");
    expect(left).toEqual(["flow1"]);
  });

  it("fires again after the key was watched anew", () => {
    const { hub, left, open } = setup();
    open("c1", "s1", "flow1");
    hub.close("c1");
    open("c2", "s1", "flow1");
    hub.close("c2");
    expect(left).toEqual(["flow1", "flow1"]);
  });

  it("is silent for another stream, for a connection that watched nothing, and for a repeated close", () => {
    const { hub, left, open } = setup();
    open("c1", "s1", "k", "session");
    hub.close("c1");
    hub.close("nobody");
    open("c2", "s1", "flow1");
    hub.close("c2");
    hub.close("c2");
    expect(left).toEqual(["flow1"]);
  });

  it("does not let a throwing listener stop the close or the other listeners", () => {
    const { hub, left, open } = setup();
    hub.onLastSubscriberLeft("login", () => {
      throw new Error("boom");
    });
    open("c1", "s1", "flow1");
    open("c1", "s2", "flow2");
    expect(() => hub.close("c1")).not.toThrow();
    expect(left.sort()).toEqual(["flow1", "flow2"]);
    expect(hub.stats().subscriptions).toBe(0);
  });
});
