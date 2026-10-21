import { describe, expect, it } from "vitest";
import { createLaunchAddresses } from "./launch-addresses.ts";

const scope = (launchId: string) => ({ agentId: "atlas-1a2b", launchId, source: "thread" as const });

describe("the launch addresses", () => {
  it("answers the launch behind an address until it is removed", () => {
    const map = createLaunchAddresses();
    map.add("10.213.0.5", scope("l1"));
    expect(map.scopeOf("10.213.0.5")).toEqual(scope("l1"));
    expect(map.scopeOf("10.213.0.6")).toBeNull();
    map.remove("l1");
    expect(map.scopeOf("10.213.0.5")).toBeNull();
  });

  it("keeps a task VM's source", () => {
    const map = createLaunchAddresses();
    map.add("10.213.0.7", { agentId: "a", launchId: "l9", source: { task: "nightly" } });
    expect(map.scopeOf("10.213.0.7")?.source).toEqual({ task: "nightly" });
  });

  it("a late removal of the old launch leaves the new one on a reused address", () => {
    const map = createLaunchAddresses();
    map.add("10.213.0.5", scope("l1"));
    map.add("10.213.0.5", scope("l2"));
    map.remove("l1");
    expect(map.scopeOf("10.213.0.5")).toEqual(scope("l2"));
    map.remove("l2");
    expect(map.scopeOf("10.213.0.5")).toBeNull();
  });

  it("forgets an unknown launch quietly", () => {
    expect(() => createLaunchAddresses().remove("nope")).not.toThrow();
  });
});
