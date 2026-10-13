import { describe, expect, it } from "vitest";
import { monthCutoff } from "../modules/audit/index.ts";

describe("monthCutoff", () => {
  it("is the first month that stays: 12 months before the current one", () => {
    expect(monthCutoff(Date.UTC(2026, 9, 12))).toBe("2025-10");
    expect(monthCutoff(Date.UTC(2026, 0, 1))).toBe("2025-01");
    expect(monthCutoff(Date.UTC(2028, 1, 29))).toBe("2027-02");
  });
});
