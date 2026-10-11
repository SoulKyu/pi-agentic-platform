import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BROWSER_TARGETS } from "../browser-targets.ts";

describe("browser floor", () => {
  it("pins Safari / iOS 16.4 in browserslist and in the Vite build target", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      browserslist: string[];
    };
    expect(pkg.browserslist).toEqual([
      "chrome 111",
      "edge 111",
      "firefox 111",
      "safari 16.4",
      "ios_saf 16.4",
    ]);
    expect(BROWSER_TARGETS).toEqual(["chrome111", "edge111", "firefox111", "safari16.4", "ios16.4"]);
  });
});
