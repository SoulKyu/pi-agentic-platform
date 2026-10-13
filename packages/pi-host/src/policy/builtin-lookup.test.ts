import { describe, expect, it } from "vitest";
import { createIsBuiltin } from "./builtin-lookup.ts";

describe("the built-in lookup of the worker's redaction", () => {
  it("is Pi's own grep when the registry says so, and not an extension's grep", () => {
    expect(createIsBuiltin(() => [{ name: "grep", sourceInfo: { path: "builtin:grep" } }])("grep")).toBe(
      true,
    );
    expect(createIsBuiltin(() => [{ name: "grep", sourceInfo: { path: "/ext/grep.ts" } }])("grep")).toBe(
      false,
    );
  });

  it("treats a name the registry does not list as not built in", () => {
    expect(createIsBuiltin(() => [])("grep")).toBe(false);
  });

  it("fails toward masking when the registry is not there yet", () => {
    expect(createIsBuiltin(() => undefined)("grep")).toBe(true);
  });

  it("fails toward masking when the registry throws", () => {
    const lookup = createIsBuiltin(() => {
      throw new Error("session disposed");
    });
    expect(lookup("grep")).toBe(true);
  });
});
