import { describe, expect, it, vi } from "vitest";
import { createDisabling } from "./disable.ts";

function build(failing: string[] = []) {
  const stopped: string[] = [];
  const fail = (id: string) => {
    if (failing.includes(id)) throw new Error("vmd down");
  };
  const disabling = createDisabling({
    boxes: {
      ownerBoxes: (owner) => (owner === "m1" ? ["p1", "p2"] : ["other"]),
      stop: async (id) => void (fail(id), stopped.push(`box:${id}`)),
    },
    agents: { list: (owner) => (owner === "m1" ? [{ id: "a1" }] : [{ id: "ao" }]) },
    stopAgent: async (id) => void (fail(id), stopped.push(`agent:${id}`)),
    logger: { warn: vi.fn() } as never,
  });
  return { disabling, stopped };
}

describe("disabling", () => {
  it("stops every box and agent VM of the user and no one else's", async () => {
    const t = build();
    await t.disabling.stopAll("m1");
    expect(t.stopped).toEqual(["box:p1", "box:p2", "agent:a1"]);
  });

  it("tries every stop when one fails, then answers internal so the owner can retry", async () => {
    const t = build(["p1"]);
    await expect(t.disabling.stopAll("m1")).rejects.toMatchObject({ code: "internal" });
    expect(t.stopped).toEqual(["box:p2", "agent:a1"]);
  });

  it("is silent when the user has nothing running", async () => {
    const t = build();
    await expect(t.disabling.stopAll("nobody")).resolves.toBeUndefined();
  });
});
