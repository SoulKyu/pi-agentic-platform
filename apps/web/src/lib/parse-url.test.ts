import { afterEach, describe, expect, it } from "vitest";
import { parseUrl } from "./parse-url.ts";

const canParse = URL.canParse;
afterEach(() => {
  URL.canParse = canParse;
});

describe("parseUrl", () => {
  it("parses an address and answers null for text that is not one", () => {
    expect(parseUrl("https://h.tld/x")?.hostname).toBe("h.tld");
    expect(parseUrl("not a url")).toBeNull();
  });

  it("works where URL.canParse does not exist (Safari 16.4)", () => {
    // @ts-expect-error -- simulating a browser without URL.canParse
    delete URL.canParse;
    expect(parseUrl("https://h.tld/x")?.protocol).toBe("https:");
  });
});
