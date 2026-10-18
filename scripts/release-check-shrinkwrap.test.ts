import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_IMPORTERS, buildShrinkwrap, productionClosure, type Shrinkwrap } from "./npm-shrinkwrap.ts";
import { checkShrinkwrap } from "./release-check-shrinkwrap.ts";

const mini = readFileSync(join(import.meta.dirname, "fixtures/pnpm-lock-mini.yaml"), "utf8");
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const dependencies = {
  "@pap/contracts": "0.0.0",
  "@scope/pkg": "2.0.0",
  alpha: "1.0.0",
  beta: "1.0.0",
  gamma: "1.0.0",
  native: "1.0.0",
  "node-pty": "1.1.0",
};

const tree = (withShrinkwrap: boolean, edit?: (shrinkwrap: Shrinkwrap) => void) => {
  const root = mkdtempSync(join(tmpdir(), "pap-sw-check-"));
  roots.push(root);
  put(join(root, "pnpm-lock.yaml"), mini);
  put(join(root, ".pap-npm/package/package.json"), JSON.stringify({ dependencies }));
  if (withShrinkwrap) {
    const shrinkwrap = buildShrinkwrap({
      name: "pkg",
      version: "0.0.0",
      rootDependencies: dependencies,
      closure: productionClosure(mini, PACKAGE_IMPORTERS),
      bundled: ["@pap/contracts"],
      installScripts: [],
    });
    edit?.(shrinkwrap);
    put(join(root, ".pap-npm/package/npm-shrinkwrap.json"), JSON.stringify(shrinkwrap));
  }
  return root;
};

describe("checkShrinkwrap", () => {
  it("does nothing when no package was built", () => {
    const root = mkdtempSync(join(tmpdir(), "pap-sw-check-"));
    roots.push(root);
    const problems: string[] = [];
    checkShrinkwrap(root, problems);
    expect(problems).toEqual([]);
  });

  it("reports a package without the file", () => {
    const problems: string[] = [];
    checkShrinkwrap(tree(false), problems);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("npm-shrinkwrap.json is missing");
  });

  it("is quiet for a shrinkwrap that equals the lockfile", () => {
    const problems: string[] = [];
    checkShrinkwrap(tree(true), problems);
    expect(problems).toEqual([]);
  });

  it("reports an entry that differs from the lockfile", () => {
    const problems: string[] = [];
    checkShrinkwrap(
      tree(true, (shrinkwrap) => {
        const entry = shrinkwrap.packages["node_modules/alpha"];
        if (entry !== undefined) entry.integrity = "sha512-AAAA";
      }),
      problems,
    );
    expect(problems.join("\n")).toContain("node_modules/alpha");
  });

  it("reports a root dependencies list that differs from the manifest", () => {
    const problems: string[] = [];
    checkShrinkwrap(
      tree(true, (shrinkwrap) => {
        const root = shrinkwrap.packages[""];
        if (root !== undefined) root.dependencies = { ...root.dependencies, alpha: "9.9.9" };
      }),
      problems,
    );
    expect(problems.join("\n")).toMatch(/dependencies/);
  });
});
