import { describe, expect, it } from "vitest";
import { PLATFORM_OPS, type PlatformOp, platformVerdict, type SessionType } from "./platform.ts";

describe("the whenTainted column (M11R212, owner a4)", () => {
  it("is pinned", () => {
    const column = Object.fromEntries(
      Object.entries(PLATFORM_OPS).map(([op, spec]) => [op, spec.whenTainted]),
    );
    expect(column).toEqual({
      "agent.notify": "run",
      "agent.approve": "run",
      "agent.delegate": "ask",
      "agent.remind": "ask",
      "lane.note": "run",
      "secret.request": "run",
      "network.request": "run",
      "subagent.run": "run",
    });
  });
});

const verdict = (
  op: PlatformOp,
  type: SessionType,
  extra: { approvedCall?: boolean; autonomous?: boolean } = {},
) => platformVerdict(op, { type, tainted: true, approvedCall: false, ...extra });

describe("platformVerdict with autonomy (owner a6 ii)", () => {
  it("lets a tainted remind and delegate of an autonomous agent thread run", () => {
    expect(verdict("agent.remind", "agent-thread", { autonomous: true })).toBeNull();
    expect(verdict("agent.delegate", "agent-thread", { autonomous: true })).toBeNull();
  });
  it("keeps them tainted when autonomous is false or absent", () => {
    expect(verdict("agent.remind", "agent-thread", { autonomous: false })).toBe("tainted");
    expect(verdict("agent.delegate", "agent-thread")).toBe("tainted");
  });
  it("is forbidden for the other session types, autonomous or not", () => {
    for (const type of ["agent-task", "child", "plain"] as const)
      for (const op of ["agent.remind", "agent.delegate"] as const)
        expect(verdict(op, type, { autonomous: true })).toBe("forbidden");
  });
  it("runs notify and approve tainted either way", () => {
    for (const op of ["agent.notify", "agent.approve"] as const) {
      expect(verdict(op, "agent-thread")).toBeNull();
      expect(verdict(op, "agent-thread", { autonomous: true })).toBeNull();
    }
  });
  it("runs an untainted remind without autonomy", () => {
    expect(
      platformVerdict("agent.remind", { type: "agent-thread", tainted: false, approvedCall: false }),
    ).toBeNull();
  });
});
