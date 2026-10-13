import { describe, expect, it } from "vitest";
import { credentialOf } from "./credentials.ts";

const TOKEN = `pap_${"A".repeat(43)}`;

describe("credentialOf", () => {
  it.each(["Bearer", "bearer", "BEARER"])("accepts the scheme %s", (scheme) => {
    expect(credentialOf({ authorization: `${scheme} ${TOKEN}` })).toEqual({ kind: "bearer", value: TOKEN });
  });

  it.each([
    ["two spaces", `Bearer  ${TOKEN}`],
    ["a tab", `Bearer\t${TOKEN}`],
    ["a trailing space", `Bearer ${TOKEN} `],
    ["no value", "Bearer "],
    ["129 characters", `Bearer ${"a".repeat(129)}`],
    ["another scheme", `Basic ${TOKEN}`],
    ["no scheme", TOKEN],
  ])("ignores a header with %s", (_name, authorization) => {
    expect(credentialOf({ authorization })).toBeUndefined();
  });

  it("accepts a value of exactly 128 characters", () => {
    const value = "a".repeat(128);
    expect(credentialOf({ authorization: `Bearer ${value}` })).toEqual({ kind: "bearer", value });
  });

  it("reads the session cookie among others", () => {
    expect(credentialOf({ cookie: "theme=dark; pap_session=abc123; x=y" })).toEqual({
      kind: "cookie",
      value: "abc123",
    });
  });

  it("ignores a cookie header without the session cookie, or with an empty one", () => {
    expect(credentialOf({ cookie: "theme=dark" })).toBeUndefined();
    expect(credentialOf({ cookie: "pap_session=" })).toBeUndefined();
  });

  it("reports a conflict when both are present", () => {
    expect(credentialOf({ cookie: "pap_session=abc", authorization: `Bearer ${TOKEN}` })).toBe("conflict");
  });

  it("keeps the cookie when the Authorization header is not a bearer", () => {
    expect(credentialOf({ cookie: "pap_session=abc", authorization: "Basic dXNlcjpwYXNz" })).toEqual({
      kind: "cookie",
      value: "abc",
    });
  });
});
