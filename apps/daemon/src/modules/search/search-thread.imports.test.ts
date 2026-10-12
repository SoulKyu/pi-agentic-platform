import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("the thread entry and what it loads import only node built-ins and each other (M4R52)", () => {
  for (const file of ["./search-thread.ts", "./query.ts", "./sqlite-codes.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const specifier of specifiers)
      expect(specifier, file).toMatch(/^(node:|\.\/(query|sqlite-codes)\.ts$)/);
  }
});
