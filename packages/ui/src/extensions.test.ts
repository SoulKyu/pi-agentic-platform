import { describe, expect, it } from "vitest";
import * as barrel from "./index.ts";
import * as extensions from "./extensions.ts";

const PROMOTED = ["AnsiText", "CustomPanel", "InputRequestCard", "StatusBar", "Widgets"] as const;

describe("@pap/ui/extensions", () => {
  it("exports the surfaces extensions draw on", () => {
    for (const name of PROMOTED) expect(typeof extensions[name]).toBe("function");
  });

  it("stays out of the eager barrel, so the first paint does not carry them", () => {
    expect(PROMOTED.filter((name) => name in barrel)).toEqual([]);
  });
});
