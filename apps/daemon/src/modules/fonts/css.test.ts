import { describe, expect, it } from "vitest";
import { parseGoogleCss } from "./css.ts";
import { face, GSTATIC } from "./testing/fake-fetcher.ts";

const good = `${GSTATIC}/fake/v1/abc-DEF_1.woff2`;

describe("parseGoogleCss", () => {
  it("keeps a gstatic woff2 face with its weight, range and subset label", () => {
    const css = face(good, { weight: "400 700", range: "U+0000-00FF, U+0131", subset: "latin" });
    expect(parseGoogleCss(css)).toEqual({
      faces: [{ url: good, weight: "400 700", unicodeRange: "U+0000-00FF, U+0131", subset: "latin" }],
      dropped: 0,
    });
  });

  it("drops every src that is not https://fonts.gstatic.com/....woff2, and never reads it as a url", () => {
    const bad = [
      "https://evil.example/s/x.woff2",
      "http://fonts.gstatic.com/s/x.woff2",
      "https://fonts.gstatic.com.evil.example/s/x.woff2",
      "https://fonts.gstatic.com@evil.example/s/x.woff2",
      "https://fonts.gstatic.com:8443/s/x.woff2",
      "https://fonts.gstatic.com/s/../x.woff2",
      "https://fonts.gstatic.com/s/x.woff",
      "https://fonts.gstatic.com/s/x.woff2?token=1",
      "data:font/woff2;base64,d09GMg==",
      "/s/x.woff2",
      "x.woff2",
      "//fonts.gstatic.com/s/x.woff2",
    ];
    const css = [...bad.map((url) => face(url)), face(good)].join("\n");
    const parsed = parseGoogleCss(css);
    expect(parsed.faces.map((entry) => entry.url)).toEqual([good]);
    expect(parsed.dropped).toBe(bad.length);
  });

  it("drops a block with a second url, a non-normal style or a malformed weight or range", () => {
    const two = face(good).replace("format('woff2');", `format('woff2'), url(${good}x) format('woff');`);
    const italic = face(good).replace("font-style: normal", "font-style: italic");
    const range = face(good, { range: "U+0000-00FF; background:url(//x)" });
    const weight = face(good, { weight: "bold" });
    expect(parseGoogleCss([two, italic, range, weight].join("\n"))).toEqual({ faces: [], dropped: 4 });
  });

  it("never scans a block over 2 KiB: a crafted 250 KiB block yields nothing, a valid one padded past the cap is dropped", () => {
    const crafted = `@font-face { ${" font-style:".repeat(22_000)} }`;
    expect(crafted.length).toBeGreaterThan(250_000);
    expect(parseGoogleCss(crafted)).toEqual({ faces: [], dropped: 1 });
    const padded = (spaces: number) =>
      face(good).replace("font-display: swap;", `font-display: swap;${" ".repeat(spaces)}`);
    expect(parseGoogleCss(padded(1500)).faces).toHaveLength(1);
    expect(parseGoogleCss(padded(2100))).toEqual({ faces: [], dropped: 1 });
  });

  it("returns no face for text without a font face", () => {
    expect(parseGoogleCss("body { color: red }")).toEqual({ faces: [], dropped: 0 });
    expect(parseGoogleCss("")).toEqual({ faces: [], dropped: 0 });
  });
});
