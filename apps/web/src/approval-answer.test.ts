import {
  ApprovalAnswer as ContractAnswer,
  type ApprovalAnswer as ContractApprovalAnswer,
} from "@pap/contracts";
import { APPROVAL_ORDER, type ApprovalAnswer as UiApprovalAnswer } from "@pap/ui";
import { describe, expect, expectTypeOf, it } from "vitest";

// Both packages export `ApprovalAnswer` (agreement 6); import sites alias one of them. This file pins them together.
describe("ApprovalAnswer of @pap/ui and of @pap/contracts", () => {
  it("are the same type, assignable in both directions", () => {
    expectTypeOf<UiApprovalAnswer>().toEqualTypeOf<ContractApprovalAnswer>();
    const fromUi = (answer: UiApprovalAnswer): ContractApprovalAnswer => answer;
    const fromContract = (answer: ContractApprovalAnswer): UiApprovalAnswer => answer;
    expect(fromUi("once")).toBe("once");
    expect(fromContract("deny")).toBe("deny");
  });

  it("list the same five answers, and the card's order names each exactly once", () => {
    expect([...APPROVAL_ORDER].sort()).toEqual([...ContractAnswer.options].sort());
    expect(new Set(APPROVAL_ORDER).size).toBe(APPROVAL_ORDER.length);
  });
});
