import { afterEach, describe, expect, it } from "vitest";
import { safeLink } from "./skills.vm.ts";

const canParse = URL.canParse;
afterEach(() => {
  URL.canParse = canParse;
});

describe("safeLink without URL.canParse (Safari 16.4)", () => {
  it("still opens an https link and refuses a broken one", () => {
    // @ts-expect-error -- simulating a browser without URL.canParse
    delete URL.canParse;
    expect(safeLink("https://skills.sh/o/r")).toBe("https://skills.sh/o/r");
    expect(safeLink("https://")).toBeNull();
  });
});
