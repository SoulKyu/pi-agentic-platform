import { readFileSync } from "node:fs";
import { WIRE_CLASSES } from "@pap/contracts";
import { expect, it } from "vitest";

// The worker imports nothing, so its list of push classes is a copy; this is the only thing that ties it to the contract.
it("CLASS_NAMES in sw.ts is exactly WIRE_CLASSES, in order", () => {
  const source = readFileSync(new URL("./sw.ts", import.meta.url), "utf8");
  const list = /const CLASS_NAMES = \[([^\]]*)\]/.exec(source)?.[1] ?? "";
  const names = [...list.matchAll(/"([a-z]+)"/g)].map((match) => match[1]);
  expect(names).toEqual([...WIRE_CLASSES]);
});
