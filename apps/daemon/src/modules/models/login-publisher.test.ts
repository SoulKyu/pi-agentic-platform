import { LoginStreamEvent } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createLoginPublisher, LOGIN_PUBLISHER_FLOWS } from "./login-publisher.ts";

function bed() {
  const published: Array<{ stream: string; key: string; event: unknown }> = [];
  const providers = new Map<string, (key: string) => unknown>();
  const publisher = createLoginPublisher({
    publish: (stream, key, event) => void published.push({ stream, key, event }),
    registerSnapshot: (stream, provider) => void providers.set(stream, provider as (key: string) => unknown),
  });
  return { publisher, published, providers };
}
const progress = (n: number) => ({ kind: "progress" as const, message: `step ${n}` });

describe("the login publisher", () => {
  it("publishes each event on the login stream under the flow id, and registers the snapshot provider", () => {
    const { publisher, published, providers } = bed();
    publisher.publish("f1", progress(1));
    expect(published).toEqual([{ stream: "login", key: "f1", event: progress(1) }]);
    expect(providers.has("login")).toBe(true);
    expect(providers.get("login")?.("f1")).toEqual({ kind: "snapshot", events: [progress(1)] });
  });

  it("answers an empty snapshot for a flow it never saw", () => {
    expect(bed().publisher.snapshot("nope")).toEqual({ kind: "snapshot", events: [] });
  });

  it("keeps the last 64 events of a flow, in order, and every snapshot parses", () => {
    const { publisher } = bed();
    for (let i = 0; i < 70; i++) publisher.publish("f1", progress(i));
    const { events } = publisher.snapshot("f1");
    expect(events).toHaveLength(64);
    expect(events[0]).toEqual(progress(6));
    expect(events[63]).toEqual(progress(69));
    expect(LoginStreamEvent.safeParse(publisher.snapshot("f1")).success).toBe(true);
  });

  it("refuses to publish an event the contract does not accept, and publishes nothing", () => {
    const { publisher, published } = bed();
    expect(() =>
      publisher.publish("f1", { kind: "auth_url", url: "javascript:alert(1)" } as never),
    ).toThrow();
    expect(() => publisher.publish("f1", { kind: "progress", message: "x", key: "sk-1" } as never)).toThrow();
    expect(published).toEqual([]);
    expect(publisher.snapshot("f1").events).toEqual([]);
  });

  it("forgets a flow", () => {
    const { publisher } = bed();
    publisher.publish("f1", progress(1));
    publisher.forget("f1");
    expect(publisher.snapshot("f1").events).toEqual([]);
  });

  it("holds at most a fixed number of flows, dropping the oldest", () => {
    const { publisher } = bed();
    for (let i = 0; i <= LOGIN_PUBLISHER_FLOWS; i++) publisher.publish(`f${i}`, progress(i));
    expect(publisher.snapshot("f0").events).toEqual([]);
    expect(publisher.snapshot("f1").events).toEqual([progress(1)]);
    expect(publisher.snapshot(`f${LOGIN_PUBLISHER_FLOWS}`).events).toHaveLength(1);
  });
});
