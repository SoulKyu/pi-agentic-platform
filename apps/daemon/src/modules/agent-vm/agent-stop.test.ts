import { PapError } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createAgentStop } from "./agent-stop.ts";

function bed(inflight?: Promise<void>) {
  const calls: string[] = [];
  const stop = createAgentStop({
    inflight: () => inflight,
    stop: async (id) => void calls.push(`stop:${id}`),
    ownerOf: (id) => (id === "a1" ? "u1" : null),
  });
  return { calls, stop };
}

describe("createAgentStop", () => {
  it("refuses a foreign or unknown agent without stopping", async () => {
    const { calls, stop } = bed();
    await expect(stop("u2", "a1")).rejects.toEqual(new PapError("not_found"));
    await expect(stop("u1", "nope")).rejects.toEqual(new PapError("not_found"));
    expect(calls).toEqual([]);
  });

  it("waits for a start in flight, even one that rejects", async () => {
    let fail!: (error: Error) => void;
    const starting = new Promise<void>((_, reject) => void (fail = reject));
    const { calls, stop } = bed(starting);
    const done = stop("u1", "a1");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);
    fail(new Error("start failed"));
    await done;
    expect(calls).toEqual(["stop:a1"]);
  });

  it("stops an agent that is already stopped", async () => {
    const { calls, stop } = bed();
    await expect(stop("u1", "a1")).resolves.toBeUndefined();
    expect(calls).toEqual(["stop:a1"]);
  });
});
