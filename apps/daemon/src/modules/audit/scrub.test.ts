import { describe, expect, it } from "vitest";
import { fitToolNames, scrubKnownSecrets } from "./scrub.ts";

const cases: Array<[string, string, string]> = [
  ["pap_token", `pap_${"A".repeat(43)}`, "[REDACTED:pap_token]"],
  ["ghp", `ghp_${"b".repeat(36)}`, "[REDACTED:github_token]"],
  ["github_pat", `github_pat_${"c".repeat(30)}`, "[REDACTED:github_token]"],
  ["anthropic", `sk-ant-api03-${"d".repeat(40)}`, "[REDACTED:anthropic_key]"],
  ["sk", `sk-${"e".repeat(48)}`, "[REDACTED:api_key]"],
  ["aws", "AKIAIOSFODNN7EXAMPLE", "[REDACTED:aws_access_key]"],
  ["slack", "xoxb-1234567890-abcdefghij", "[REDACTED:slack_token]"],
  ["jwt", `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`, "[REDACTED:jwt]"],
  ["bearer", `Authorization: bearer ${"x".repeat(25)}`, "Authorization: [REDACTED:bearer]"],
  ["BEARER", `BEARER\t${"y.".repeat(12)}`, "[REDACTED:bearer]"],
  ["pem", "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----", "[REDACTED:private_key]"],
  ["pem without end", "x -----BEGIN PRIVATE KEY-----\nabc\ndef", "x [REDACTED:private_key]"],
];

describe("scrubKnownSecrets", () => {
  it.each(cases)("replaces a %s", (_name, input, expected) => {
    expect(scrubKnownSecrets(input)).toEqual({ text: expected, count: 1 });
  });

  it("replaces several in one text and counts them", () => {
    const text = `a ghp_${"b".repeat(36)} b AKIAIOSFODNN7EXAMPLE c`;
    expect(scrubKnownSecrets(text)).toEqual({
      text: "a [REDACTED:github_token] b [REDACTED:aws_access_key] c",
      count: 2,
    });
  });

  it.each([
    "ghp_short",
    "sk-short",
    "AKIA123",
    "skeleton-key-is-not-a-secret",
    "task-1234567890123456789012345",
    "bearer short",
  ])("leaves %s alone", (input) => {
    expect(scrubKnownSecrets(input)).toEqual({ text: input, count: 0 });
  });

  // Bounded repetition keeps these linear. Text made of the format's own alphabet is a match, not an escape (the
  // brief expected "unchanged" for `sk-` and the JWT unit, which the prescribed expressions do not give).
  it("stays linear on 25 000 copies of ghp_, which never reach 20 characters", () => {
    const text = "ghp_".repeat(25_000);
    expect(scrubKnownSecrets(text)).toEqual({ text, count: 0 });
  });

  it("stays linear on 30 000 copies of sk-, cut into 258-character keys", () => {
    expect(scrubKnownSecrets("sk-".repeat(30_000))).toEqual({
      text: "[REDACTED:api_key]".repeat(349),
      count: 349,
    });
  });

  it("stays linear on 10 000 copies of a JWT unit, three units to a token", () => {
    expect(scrubKnownSecrets("eyJaaaaaaaa.".repeat(10_000))).toEqual({
      text: `${"[REDACTED:jwt].".repeat(3_333)}eyJaaaaaaaa.`,
      count: 3_333,
    });
  });

  it("does not go super-linear on a dash-separated run of JWT heads (4 MiB, a safety net of 3 s)", () => {
    const text = "eyJ-".repeat(1_048_576);
    const started = performance.now();
    expect(scrubKnownSecrets(text)).toEqual({ text, count: 0 });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it("does not match a JWT glued to a token character before it (accepted trade-off)", () => {
    const jwt = `eyJ${"a".repeat(10)}.${"b".repeat(10)}.${"c".repeat(10)}`;
    expect(scrubKnownSecrets(`-${jwt}`)).toEqual({ text: `-${jwt}`, count: 0 });
    expect(scrubKnownSecrets(` ${jwt}`)).toEqual({ text: " [REDACTED:jwt]", count: 1 });
  });

  it("stays linear on a JWT head that never gets its second dot", () => {
    const text = `eyJ${"a".repeat(8)}.${"b".repeat(8)}!`.repeat(5_000);
    expect(scrubKnownSecrets(text)).toEqual({ text, count: 0 });
  });
});

describe("fitToolNames", () => {
  it("keeps every name when the JSON fits in 4000 characters", () => {
    expect(fitToolNames(["a", "b"], 2)).toEqual({ count: 2, truncated: false, names: ["a", "b"] });
  });

  it("puts extra fields before the names and counts them in the fit", () => {
    const names = Array.from({ length: 256 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(253)}`);
    const fitted = fitToolNames(names, 256, { mode: "auto-accept-edits" });
    expect(Object.keys(fitted)).toEqual(["count", "truncated", "mode", "names"]);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(4_000);
    expect(fitted.names).toEqual(names.slice(0, fitted.names.length));
    expect(
      JSON.stringify({ ...fitted, names: names.slice(0, fitted.names.length + 1) }).length,
    ).toBeGreaterThan(4_000);
  });

  it("drops names from the end until it fits, and keeps the count", () => {
    const names = Array.from({ length: 256 }, (_, i) => `${String(i).padStart(3, "0")}${"x".repeat(253)}`);
    const fitted = fitToolNames(names, 256);
    expect(fitted).toMatchObject({ count: 256, truncated: true });
    expect(fitted.names).toEqual(names.slice(0, 15));
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(4_000);
  });
});
