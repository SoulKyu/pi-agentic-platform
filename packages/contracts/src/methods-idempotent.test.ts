import { describe, expect, it } from "vitest";
import { methods } from "./methods.ts";
import { METHOD_IDEMPOTENT } from "./methods-idempotent.ts";

describe("METHOD_IDEMPOTENT", () => {
  it("lists exactly the catalogue's methods", () => {
    expect(Object.keys(METHOD_IDEMPOTENT).sort()).toEqual(Object.keys(methods).sort());
  });

  it("equals methods[*].idempotent for every method", () => {
    for (const [name, def] of Object.entries(methods)) {
      expect([name, METHOD_IDEMPOTENT[name as keyof typeof METHOD_IDEMPOTENT]]).toEqual([
        name,
        def.idempotent,
      ]);
    }
  });
});
