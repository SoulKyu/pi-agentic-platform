import { describe, expect, it } from "vitest";
import {
  checkBaseUrl,
  HTTP_PLAINTEXT_POLICY,
  type HttpPlaintextPolicy,
  keyTravelsInClear,
  plainLine,
} from "./base-url.ts";
import { BASE_URL_TABLE, type Verdict } from "./base-url-table.ts";

const verdict = (url: string, policy?: HttpPlaintextPolicy): Verdict => {
  const r = policy === undefined ? checkBaseUrl(url) : checkBaseUrl(url, policy);
  return r.ok ? "ok" : r.reason;
};

describe("BASE_URL_TABLE: the one table of the base URL policy (owner q4, MPR9)", () => {
  it("has 32 rows", () => expect(BASE_URL_TABLE).toHaveLength(32));

  it.each(BASE_URL_TABLE.map((row, index) => [index, ...row] as const))(
    "row %i: %s",
    (_index, url, loopback, any) => {
      expect(verdict(url, "loopback")).toBe(loopback);
      expect(verdict(url, "any")).toBe(any);
      // The shipped column is chosen by the constant: flipping it changes no test.
      expect(verdict(url)).toBe(HTTP_PLAINTEXT_POLICY === "loopback" ? loopback : any);
    },
  );

  it("normalises a numeric loopback host to the dotted quad", () => {
    expect(checkBaseUrl("http://0x7f.1/")).toEqual({ ok: true, url: "http://127.0.0.1" });
    expect(checkBaseUrl("https://api.example.com/v1/")).toEqual({
      ok: true,
      url: "https://api.example.com/v1",
    });
  });
});

describe("keyTravelsInClear", () => {
  it("is true for a key sent in plain http to another host", () => {
    expect(keyTravelsInClear("http://192.168.1.5:11434/v1", true)).toBe(true);
  });
  it("counts a secret header like a key: the caller says whether anything secret rides along", () => {
    expect(keyTravelsInClear("http://192.168.1.5:11434/v1", true)).toBe(true);
    expect(keyTravelsInClear("http://192.168.1.5:11434/v1", false)).toBe(false);
  });
  it("is false with no key, on loopback, on https and for a refused URL", () => {
    expect(keyTravelsInClear("http://192.168.1.5:11434/v1", false)).toBe(false);
    expect(keyTravelsInClear("http://localhost:11434/v1", true)).toBe(false);
    expect(keyTravelsInClear("https://api.example.com/v1", true)).toBe(false);
    expect(keyTravelsInClear("ftp://x", true)).toBe(false);
  });
});

describe("plainLine", () => {
  it.each(
    [
      0x0a, 0x7f, 0x85, 0x2028, 0x2029, 0xfeff, 0x200b, 0x200f, 0x202a, 0x202e, 0x2066, 0x2069, 0xad, 0x61c,
      0x180e, 0x2060, 0x2064, 0x2065, 0x206f, 0xe0000, 0xe0041, 0xe007f, 0xa0,
    ].map((cp) => [`0x${cp.toString(16)}`, cp] as const),
  )("refuses %s", (_label, cp) => expect(plainLine(`a${String.fromCodePoint(cp)}b`)).toBe(false));
  it("refuses every code point of U+2060 to U+206F (U+2065 is unassigned, so Cf misses it)", () => {
    for (let cp = 0x2060; cp <= 0x206f; cp++)
      expect(plainLine(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe(false);
  });
  it("accepts visible text", () => expect(plainLine("Modèle 7B — ok")).toBe(true));
});

describe("checkBaseUrl: length of the normalised output (Task 8 review minor a)", () => {
  it("refuses a URL whose normalised form is over the limit, so a saved provider reopens", () => {
    // `0x7f.1` is short as typed; the path makes the normalised form (`http://127.0.0.1/...`) longer than the raw text.
    const path = "a".repeat(2048 - "http://0x7f.1/".length);
    const raw = `http://0x7f.1/${path}`;
    expect(raw.length).toBeLessThanOrEqual(2048);
    expect(checkBaseUrl(raw)).toEqual({ ok: false, reason: "too_long" });
    // a percent-encoding expansion grows the output past the input
    const spaces = `https://x.example.com/${"\u00e9".repeat(1000)}`;
    expect(checkBaseUrl(spaces)).toEqual({ ok: false, reason: "too_long" });
    // one character under the limit after normalising is still accepted
    const fits = `http://0x7f.1/${"a".repeat(2048 - "http://127.0.0.1/".length)}`;
    expect(checkBaseUrl(fits)).toMatchObject({ ok: true });
  });
});
