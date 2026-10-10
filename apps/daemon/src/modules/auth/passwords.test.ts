import { randomBytes, scryptSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createDummyHash, hashPassword, isAcceptablePassword, verifyPassword } from "./passwords.ts";

describe("passwords", () => {
  it("verifies the right password only", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$32768$8$3$")).toBe(true);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", stored)).toBe(false);
  });

  it("still verifies a hash made with the earlier p=1 parameters", async () => {
    const salt = randomBytes(16);
    const key = scryptSync("correct horse battery staple", salt, 64, {
      N: 2 ** 15,
      r: 8,
      p: 1,
      maxmem: 64 << 20,
    });
    const old = `scrypt$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
    expect(await verifyPassword("correct horse battery staple", old)).toBe(true);
    expect(await verifyPassword("correct horse battery stapl", old)).toBe(false);
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

describe("dummy hash", () => {
  it("is computed once and shared", async () => {
    let calls = 0;
    const dummy = createDummyHash(async () => `hash-${++calls}`);
    expect(await Promise.all([dummy(), dummy()])).toEqual(["hash-1", "hash-1"]);
    expect(await dummy()).toBe("hash-1");
    expect(calls).toBe(1);
  });

  it("forgets a failure instead of failing every later call", async () => {
    let calls = 0;
    const dummy = createDummyHash(async () => {
      if (++calls === 1) throw new Error("out of memory");
      return "hash-ok";
    });
    await expect(dummy()).rejects.toThrow("out of memory");
    expect(await dummy()).toBe("hash-ok");
    expect(await dummy()).toBe("hash-ok");
    expect(calls).toBe(2);
  });
});
