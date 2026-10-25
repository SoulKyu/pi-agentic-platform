import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ClientPath, collectClientPaths } from "./index.ts";

describe("ClientPath", () => {
  const schema = z.object({ a: ClientPath, nested: z.array(z.object({ b: ClientPath.optional() })) });

  it("records the paths of nested fields during a collect, and nothing outside it", () => {
    const { value, paths } = collectClientPaths(() =>
      schema.parse({ a: "/x/y", nested: [{ b: "/z" }, {}, { b: "/w" }] }),
    );
    expect(value.a).toBe("/x/y");
    expect(paths).toEqual(["/x/y", "/z", "/w"]);
    expect(collectClientPaths(() => schema.parse({ a: "/q", nested: [] })).paths).toEqual(["/q"]);
    schema.parse({ a: "/outside", nested: [] });
    expect(collectClientPaths(() => 1).paths).toEqual([]);
  });

  it("refuses relative paths, NUL and over-long ones", () => {
    for (const bad of ["rel/path", "", "/a\0b", `/${"a".repeat(4096)}`])
      expect(ClientPath.safeParse(bad).success, bad).toBe(false);
  });

  it("is not recorded when the parse fails", () => {
    const { paths } = collectClientPaths(() => schema.safeParse({ a: "/ok", nested: [{ b: "no" }] }));
    expect(paths).not.toContain("no");
  });
});
