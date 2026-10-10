import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineMethod, type HandlerTable } from "./index.ts";

describe("compile-time guarantees", () => {
  it("a handler table missing a method does not compile", () => {
    // @ts-expect-error -- every method of the catalogue needs a handler
    const incomplete: HandlerTable = { "system.ping": async () => ({ now: 0 }) };
    expect(Object.keys(incomplete)).toEqual(["system.ping"]);
  });

  it("a method without a permission does not compile", () => {
    // @ts-expect-error -- permission is mandatory
    const def = defineMethod({
      name: "x.y",
      idempotent: true,
      params: z.object({}),
      result: z.object({}),
      errors: [],
    });
    expect(def.name).toBe("x.y");
  });
});
