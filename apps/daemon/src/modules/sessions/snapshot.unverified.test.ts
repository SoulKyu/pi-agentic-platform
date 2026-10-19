import { describe, expect, it } from "vitest";
import type { Dialog, TranscriptRow } from "@pap/contracts";
import { fitRow, fitSnapshot, ROW_BYTES } from "./snapshot.ts";

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

describe("the placeholder that stands for a row keeps the mark too", () => {
  // Mutant: build `stand` from entryId and message only: killed here.
  it("a forged user row the snapshot cannot fit stands as a marked placeholder", () => {
    const bound = (n: number): TranscriptRow => ({
      entryId: `e${n}`,
      message: { role: "assistant", timestamp: n, content: [{ type: "text", text: "b" }] },
    });
    const run = (n: number): TranscriptRow => ({
      entryId: null,
      message: { role: "user", timestamp: n, content: "r".repeat(20_000) },
      unverified: true,
    });
    const dialog: Dialog = { id: "x1", method: "editor", title: "x1", prefill: "p".repeat(30_000) };
    const rows = [bound(1), bound(2), bound(3), run(4), run(5), run(6), run(7)];
    const snapshot = fitSnapshot({ status: "running", rows, dialogs: [dialog] }, 100_000);
    const placeholder = snapshot.rows.find((row) => (row.message as { omitted?: boolean }).omitted === true);
    expect(placeholder?.unverified).toBe(true);
  });
});
