import { describe, expect, it } from "vitest";
import { hashPassword, isAcceptablePassword, verifyPassword } from "./passwords.ts";

describe("passwords", () => {
  it("verifies the right password only", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$32768$8$1$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("salts every hash and never stores the password", async () => {
    const [first, second] = await Promise.all([
      hashPassword("same password 123"),
      hashPassword("same password 123"),
    ]);
    expect(first).not.toBe(second);
    expect(first).not.toContain("same password");
  });

  it("treats composed and decomposed accents as the same password", async () => {
    const composed = "caf\u00e9-cr\u00e8me-2026".normalize("NFC");
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const stored = await hashPassword(decomposed);
    expect(await verifyPassword(composed, stored)).toBe(true);
    expect(await verifyPassword(decomposed, stored)).toBe(true);
  });

  it("rejects a malformed stored hash without throwing", async () => {
    const malformed = [
      "md5$abc",
      "",
      "scrypt$x$y$z$a$b",
      "scrypt$32768$8$1$c2FsdA$c2hvcnQ",
      "scrypt$32768$8$1$$",
      `scrypt$${2 ** 31}$8$1$c2FsdA$c2hvcnQ`,
    ];
    for (const stored of malformed) expect(await verifyPassword("anything", stored), stored).toBe(false);
  });

  it("accepts 12 to 1024 characters, counted as characters and after normalisation", () => {
    const emoji = String.fromCodePoint(0x1f600);
    const accented = "\u00e9".normalize("NFD");
    expect(accented.length).toBe(2);
    expect(isAcceptablePassword("a".repeat(11))).toBe(false);
    expect(isAcceptablePassword("a".repeat(12))).toBe(true);
    expect(isAcceptablePassword("a".repeat(1024))).toBe(true);
    expect(isAcceptablePassword("a".repeat(1025))).toBe(false);
    expect(isAcceptablePassword(emoji.repeat(11))).toBe(false);
    expect(isAcceptablePassword(emoji.repeat(12))).toBe(true);
    expect(isAcceptablePassword(accented.repeat(11))).toBe(false);
    expect(isAcceptablePassword(accented.repeat(12))).toBe(true);
  });
});
