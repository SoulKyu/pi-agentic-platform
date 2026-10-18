import { describe, expect, it } from "vitest";
import {
  buildShrinkwrap,
  productionClosure,
  verifyShrinkwrap,
  type Shrinkwrap,
  type ShrinkwrapPackage,
} from "./npm-shrinkwrap.ts";

const clone = (shrinkwrap: Shrinkwrap): Shrinkwrap => structuredClone(shrinkwrap);
const at = (shrinkwrap: Shrinkwrap, path: string): ShrinkwrapPackage => {
  const entry = shrinkwrap.packages[path];
  if (entry === undefined) throw new Error(`${path} is not in the shrinkwrap`);
  return entry;
};

describe("entries nothing resolves to", () => {
  const entry = (name: string, version: string) =>
    `  ${name}@${version}:\n    resolution: {integrity: sha512-${name}${version}}\n`;
  const lock = `lockfileVersion: '9.0'
importers:
  apps/daemon:
    dependencies:
      x: {specifier: 1.0.0, version: 1.0.0}
      a: {specifier: 2.0.0, version: 2.0.0}
      b: {specifier: 2.0.0, version: 2.0.0}
packages:
${[
  ["x", "1.0.0"],
  ["a", "1.0.0"],
  ["a", "2.0.0"],
  ["b", "1.0.0"],
  ["b", "2.0.0"],
  ["p", "1.0.0"],
  ["p", "2.0.0"],
]
  .map(([name, version]) => entry(name as string, version as string))
  .join("")}snapshots:
  x@1.0.0:
    dependencies: {a: 1.0.0, b: 1.0.0, p: 2.0.0}
  a@1.0.0:
    dependencies: {p: 1.0.0}
  b@1.0.0:
    dependencies: {p: 1.0.0}
  a@2.0.0: {}
  b@2.0.0: {}
  p@1.0.0: {}
  p@2.0.0: {}
`;
  const importers = ["apps/daemon"];
  const built = () =>
    buildShrinkwrap({
      name: "pkg",
      version: "1.0.0",
      rootDependencies: { x: "1.0.0", a: "2.0.0", b: "2.0.0" },
      closure: productionClosure(lock, importers),
      bundled: [],
      installScripts: [],
    });

  it("the builder prunes the hoisted copy that every dependent shadows", () => {
    const shrinkwrap = built();
    expect(shrinkwrap.packages["node_modules/p"]).toBeUndefined();
    expect(at(shrinkwrap, "node_modules/x/node_modules/p").version).toBe("2.0.0");
    expect(at(shrinkwrap, "node_modules/x/node_modules/a/node_modules/p").version).toBe("1.0.0");
    expect(at(shrinkwrap, "node_modules/x/node_modules/b/node_modules/p").version).toBe("1.0.0");
    expect(verifyShrinkwrap(shrinkwrap, lock, importers)).toEqual([]);
  });

  it("verify reports an extraneous entry that is a real lockfile version", () => {
    const shrinkwrap = clone(built());
    shrinkwrap.packages["node_modules/p"] = clone(built()).packages[
      "node_modules/x/node_modules/p"
    ] as ShrinkwrapPackage;
    const problems = verifyShrinkwrap(shrinkwrap, lock, importers);
    expect(problems).toEqual(["node_modules/p: an entry nothing resolves to"]);
  });
});
