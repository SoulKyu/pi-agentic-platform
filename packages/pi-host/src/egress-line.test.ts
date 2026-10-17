import { describe, expect, it } from "vitest";
import { refusalAdviceOf } from "./egress-line.ts";

describe("which advice a refusal line gives (Task 29b, carry 2)", () => {
  it("follows the rules' profile and the tools the worker has, not the mount view", () => {
    expect(refusalAdviceOf("isolated-task", ["network.request"])).toBe("isolated");
    expect(refusalAdviceOf("isolated-task", [])).toBe("isolated");
    expect(refusalAdviceOf("agent-thread", ["network.request", "agent.notify"])).toBe("thread");
    // A child of an agent thread has the thread's profile and none of its tools.
    expect(refusalAdviceOf("agent-thread", [])).toBe("child");
    expect(refusalAdviceOf("agent-thread", ["agent.notify"])).toBe("child");
    expect(refusalAdviceOf(undefined, [])).toBe("child");
  });
});
