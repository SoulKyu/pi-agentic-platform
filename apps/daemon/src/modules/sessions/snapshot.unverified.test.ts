import { describe, expect, it } from "vitest";
import { fitRow, ROW_BYTES } from "./snapshot.ts";

describe("fitRow keeps the mark of a forged user entry (R32)", () => {
  // Mutant: rebuild the bounded row from entryId and message only: killed here, a forged image too big to show would show as sent.
  it("an oversized user row is bounded and still unverified", () => {
    const big = {
      entryId: "u1",
      message: { role: "user", content: "x".repeat(ROW_BYTES * 2) },
      unverified: true as const,
    };
    const { row, size } = fitRow(big);
    expect(row.unverified).toBe(true);
    expect(row.entryId).toBe("u1");
    expect(size).toBeLessThan(ROW_BYTES);
  });

  it("a row that fits is returned as it is", () => {
    const small = { entryId: "u1", message: { role: "user", content: "hi" }, unverified: true as const };
    expect(fitRow(small).row).toBe(small);
  });
});
