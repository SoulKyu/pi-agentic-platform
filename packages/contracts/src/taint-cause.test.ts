import { describe, expect, it } from "vitest";
import { ApprovalRequestRecord, Dialog, TaintCause } from "./index.ts";

const cause = { tool: "todo", source: "/x/ext/todo.ts", at: 1_700_000_000_000, count: 3, markable: true };
const causes = (n: number, older = 0) => ({ list: Array(n).fill(cause), older });
const card = {
  type: "approval_request",
  id: "a1",
  category: "exec",
  title: "Run",
  message: "bash",
  answers: ["deny", "once"],
  tool: "bash",
  key: "a".repeat(64),
  tainted: true,
};

describe("taint causes (decision 117, A3)", () => {
  it("a card without causes still parses, and one with causes keeps them", () => {
    expect(ApprovalRequestRecord.safeParse(card).data).not.toHaveProperty("taintCauses");
    expect(ApprovalRequestRecord.parse({ ...card, taintCauses: causes(1, 2) }).taintCauses).toEqual(
      causes(1, 2),
    );
  });

  it("refuses 9 causes and accepts 8", () => {
    expect(ApprovalRequestRecord.safeParse({ ...card, taintCauses: causes(8) }).success).toBe(true);
    expect(ApprovalRequestRecord.safeParse({ ...card, taintCauses: causes(9) }).success).toBe(false);
  });

  it("refuses a control or format character, an empty or long source, and a bad tool name", () => {
    for (const source of ["/x/\u0007y", "/x/\u202ey", "/x/\u2028y", "", "a".repeat(1025)])
      expect(TaintCause.safeParse({ ...cause, source }).success).toBe(false);
    expect(TaintCause.safeParse({ ...cause, tool: "a b" }).success).toBe(false);
    expect(TaintCause.safeParse({ ...cause, at: -1 }).success).toBe(false);
    expect(TaintCause.safeParse({ ...cause, count: 0 }).success).toBe(false);
    expect(ApprovalRequestRecord.safeParse({ ...card, taintCauses: { list: [], older: -1 } }).success).toBe(
      false,
    );
    expect(TaintCause.safeParse({ ...cause, extra: 1 }).success).toBe(false);
  });

  it("the dialog carries the causes too", () => {
    const dialog = {
      id: "a1",
      method: "approval",
      title: "t",
      category: "exec",
      answers: ["deny", "once"],
      tainted: true,
    };
    expect(Dialog.parse({ ...dialog, taintCauses: causes(1) }).taintCauses).toEqual(causes(1));
  });
});
