import { describe, expect, it } from "vitest";
import { coverText } from "./rule-text.ts";

describe("coverText", () => {
  it("shows a prefix as its words and an ellipsis, without invisible characters", () => {
    expect(coverText({ kind: "prefix", pattern: ["pnpm", "te‮st"] }, "any input")).toBe("pnpm test …");
  });
  it("shows a tool rule as the caller's words", () => {
    expect(coverText({ kind: "tool" }, "toute entrée")).toBe("toute entrée");
  });
  it("leaves an exact rule, an older rule and a prefix without words to the label", () => {
    expect(coverText({ kind: "exact" }, "x")).toBeNull();
    expect(coverText({}, "x")).toBeNull();
    expect(coverText({ kind: "prefix" }, "x")).toBeNull();
    expect(coverText({ kind: "prefix", pattern: [] }, "x")).toBeNull();
  });
});
