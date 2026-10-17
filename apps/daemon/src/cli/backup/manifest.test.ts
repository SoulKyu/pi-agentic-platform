import { describe, expect, it } from "vitest";
import { ManifestSchema, secretsAllowed } from "./manifest.ts";

const valid = {
  format: 1,
  papVersion: "0.0.0",
  createdAt: "2026-10-17T10:00:00.000Z",
  schema: ["kernel/202610100000_init.sql", "auth/202610110000_users.sql"],
  stateDb: { sha256: "a".repeat(64), bytes: 4096 },
  secrets: "excluded",
  tops: ["agents", "pi-agent"],
  skipped: { links: 1, names: 2, changed: 3 },
};

describe("ManifestSchema", () => {
  it("parses a valid manifest and keeps the three skipped counters", () => {
    const parsed = ManifestSchema.parse(valid);
    expect(parsed.skipped).toEqual({ links: 1, names: 2, changed: 3 });
  });

  it.each([
    ["an extra key", { ...valid, extra: 1 }],
    ["an extra key in skipped", { ...valid, skipped: { ...valid.skipped, more: 1 } }],
    ["format 2", { ...valid, format: 2 }],
    ["a bad migration id", { ...valid, schema: ["../evil.sql"] }],
    ["a short sha256", { ...valid, stateDb: { sha256: "ab", bytes: 1 } }],
    ["a missing changed counter", { ...valid, skipped: { links: 0, names: 0 } }],
    ["a bad date", { ...valid, createdAt: "yesterday" }],
    ["an unknown top", { ...valid, tops: ["worktrees"] }],
    ["secrets included without a secrets top", { ...valid, secrets: "included" }],
    ["a secrets top while excluded", { ...valid, tops: ["secrets"] }],
  ])("refuses %s", (_name, value) => {
    expect(ManifestSchema.safeParse(value).success).toBe(false);
  });

  it("accepts included secrets with the secrets top", () => {
    expect(ManifestSchema.safeParse({ ...valid, secrets: "included", tops: ["secrets"] }).success).toBe(true);
  });
});

describe("secretsAllowed", () => {
  it.each([
    ["exclude", false, false],
    ["exclude", true, false],
    ["include", false, false],
    ["include", true, true],
  ] as const)("secrets %s, encrypt %s -> %s", (secrets, encrypt, expected) => {
    expect(secretsAllowed({ secrets, encrypt })).toBe(expected);
  });
});
