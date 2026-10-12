import { describe, expect, it } from "vitest";
import { queueMore } from "./queue.vm.ts";

const queue = (steering: string[], followUp: string[], count: number) => ({
  steering,
  followUp,
  count,
  bytes: 0,
});

describe("queueMore", () => {
  it("is what the count says exists beyond the previews shown", () => {
    expect(queueMore(queue(["a"], ["b", "c"], 3))).toBe(0);
    expect(queueMore(queue(["a", "b"], [], 5))).toBe(3);
    expect(queueMore(queue([], [], 0))).toBe(0);
  });

  it("never goes negative when the previews outnumber the count", () => {
    expect(queueMore(queue(["a", "b"], ["c"], 1))).toBe(0);
  });
});
