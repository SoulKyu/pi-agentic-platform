import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildShrinkwrap,
  productionClosure,
  verifyShrinkwrap,
  type ClosureEntry,
  type Shrinkwrap,
  type ShrinkwrapPackage,
} from "./npm-shrinkwrap.ts";

const mini = readFileSync(join(import.meta.dirname, "fixtures/pnpm-lock-mini.yaml"), "utf8");
const IMPORTERS = ["apps/daemon", "packages/contracts", "packages/pi-host"];
const BUNDLED = ["@pap/contracts"];

const rootDependencies = {
  "@pap/contracts": "0.0.0",
  "@scope/pkg": "2.0.0",
  alpha: "1.0.0",
  beta: "1.0.0",
  gamma: "1.0.0",
  native: "1.0.0",
  "node-pty": "1.1.0",
};
const build = (
  root: Record<string, string> = rootDependencies,
  closure = productionClosure(mini, IMPORTERS),
) =>
  buildShrinkwrap({
    name: "pkg",
    version: "1.2.3",
    rootDependencies: root,
    closure,
    bundled: BUNDLED,
    installScripts: ["node-pty"],
  });
const find = (closure: ClosureEntry[], name: string, version: string) =>
  closure.find((entry) => entry.name === name && entry.version === version);
const at = (shrinkwrap: Shrinkwrap, path: string): ShrinkwrapPackage => {
  const entry = shrinkwrap.packages[path];
  if (entry === undefined) throw new Error(`${path} is not in the shrinkwrap`);
  return entry;
};
const clone = (shrinkwrap: Shrinkwrap): Shrinkwrap => structuredClone(shrinkwrap);

describe("productionClosure", () => {
  const closure = productionClosure(mini, IMPORTERS);
  const names = closure.map((entry) => `${entry.name}@${entry.version}`);

  it("keeps the production packages and drops dev-only and workspace-only ones", () => {
    expect(names).toEqual([
      "@native/linux-x64-glibc@1.0.0",
      "@scope/pkg@2.0.0",
      "alpha@1.0.0",
      "beta@1.0.0",
      "gamma@1.0.0",
      "native@1.0.0",
      "node-pty@1.1.0",
      "peer-dep@1.0.0",
      "shared@1.0.0",
      "shared@2.0.0",
    ]);
  });

  it("strips peer suffixes from keys and from edges", () => {
    const scoped = find(closure, "@scope/pkg", "2.0.0");
    expect(scoped?.dependencies).toEqual({ "peer-dep": "1.0.0" });
    expect(scoped?.peerDependencies).toEqual({ "peer-dep": "^1.0.0" });
  });

  it("copies integrity from the lockfile and builds the registry URL (scoped names use the bare file name)", () => {
    for (const entry of closure) expect(entry.integrity).toMatch(/^sha512-/);
    expect(find(closure, "alpha", "1.0.0")?.resolved).toBe(
      "https://registry.npmjs.org/alpha/-/alpha-1.0.0.tgz",
    );
    expect(find(closure, "@scope/pkg", "2.0.0")?.resolved).toBe(
      "https://registry.npmjs.org/@scope/pkg/-/pkg-2.0.0.tgz",
    );
    const integrity = /["']@scope\/pkg@2\.0\.0["']:\n\s+resolution: \{integrity: (\S+)\}/.exec(mini)?.[1];
    expect(find(closure, "@scope/pkg", "2.0.0")?.integrity).toBe(integrity);
  });

  it("marks entries reachable only through optional edges, and keeps os, cpu and libc", () => {
    const platform = find(closure, "@native/linux-x64-glibc", "1.0.0");
    expect(platform).toMatchObject({ optional: true, os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
    expect(find(closure, "native", "1.0.0")?.optionalDependencies).toEqual({
      "@native/linux-x64-glibc": "1.0.0",
    });
    expect(find(closure, "native", "1.0.0")?.optional).toBe(false);
  });

  it("an entry also reached through a required edge is not optional", () => {
    const text = mini.replace(
      "  gamma@1.0.0:\n    dependencies:\n      shared: 2.0.0\n",
      "  gamma@1.0.0:\n    dependencies:\n      shared: 2.0.0\n      '@native/linux-x64-glibc': 1.0.0\n",
    );
    expect(find(productionClosure(text, IMPORTERS), "@native/linux-x64-glibc", "1.0.0")?.optional).toBe(
      false,
    );
  });

  it("merges two snapshots that differ only by peer suffix (same stripped edges) into one entry", () => {
    const text = mini.replace(
      "  beta@1.0.0:\n    dependencies:",
      "  beta@1.0.0(peer-dep@1.0.0):\n    dependencies:\n      shared: 1.0.0\n\n  beta@1.0.0:\n    dependencies:",
    );
    const closureOfText = productionClosure(text, IMPORTERS);
    const beta = find(closureOfText, "beta", "1.0.0");
    expect(beta?.version).toBe("1.0.0");
    expect(beta?.dependencies).toEqual({ shared: "1.0.0" });
    expect(closureOfText.filter((entry) => entry.name === "beta")).toHaveLength(1);
  });

  it("throws when two snapshots of one package have different stripped edges, naming both", () => {
    const text = mini.replace(
      "  beta@1.0.0:\n    dependencies:",
      "  beta@1.0.0(peer-dep@1.0.0):\n    dependencies:\n      peer-dep: 1.0.0\n      shared: 1.0.0\n\n  beta@1.0.0:\n    dependencies:",
    );
    expect(() => productionClosure(text, IMPORTERS)).toThrow(
      /beta@1\.0\.0 has snapshots with different dependencies.*beta@1\.0\.0\(peer-dep@1\.0\.0\).*"peer-dep":"1\.0\.0"/,
    );
  });

  it("throws on diverging peer variants that resolve a peer to two versions (review repro)", () => {
    const lock = `lockfileVersion: '9.0'
importers:
  apps/daemon:
    dependencies:
      x: {specifier: 1.0.0, version: 1.0.0(q@1.0.0)}
      y: {specifier: 1.0.0, version: 1.0.0(q@2.0.0)}
packages:
  x@1.0.0: {resolution: {integrity: sha512-x}}
  y@1.0.0: {resolution: {integrity: sha512-y}}
  p@1.0.0: {resolution: {integrity: sha512-p}}
  q@1.0.0: {resolution: {integrity: sha512-q1}}
  q@2.0.0: {resolution: {integrity: sha512-q2}}
snapshots:
  x@1.0.0(q@1.0.0):
    dependencies: {p: 1.0.0(q@1.0.0)}
  y@1.0.0(q@2.0.0):
    dependencies: {p: 1.0.0(q@2.0.0), q: 2.0.0}
  p@1.0.0(q@1.0.0):
    dependencies: {q: 1.0.0}
  p@1.0.0(q@2.0.0):
    dependencies: {q: 2.0.0}
  q@1.0.0: {}
  q@2.0.0: {}
`;
    expect(() => productionClosure(lock, ["apps/daemon"])).toThrow(/p@1\.0\.0 has snapshots with different/);
  });

  it("refuses a resolution that is not a registry tarball", () => {
    for (const bad of [
      "resolution: {tarball: https://example.test/alpha.tgz}",
      "resolution: {type: git, repo: https://example.test/alpha.git, commit: abc}",
      "resolution: {directory: ../alpha, type: directory}",
    ]) {
      const text = mini.replace(/( {2}alpha@1\.0\.0:\n) {4}resolution: \{[^}]*\}/, `$1    ${bad}`);
      expect(() => productionClosure(text, IMPORTERS), bad).toThrow(/alpha/);
    }
  });

  it("refuses an edge that is not a plain version", () => {
    const text = mini.replace(
      "      shared: 1.0.0\n\n  beta",
      "      shared: github.com/x/shared/abc\n\n  beta",
    );
    expect(() => productionClosure(text, IMPORTERS)).toThrow(/shared/);
  });

  it("refuses an importer the lockfile does not have", () => {
    expect(() => productionClosure(mini, ["apps/nope"])).toThrow(/apps\/nope/);
  });
});

describe("buildShrinkwrap", () => {
  const paths = (shrinkwrap: Shrinkwrap) => Object.keys(shrinkwrap.packages);

  it("hoists the version most dependents use and nests the minority under its dependent", () => {
    const shrinkwrap = build();
    expect(shrinkwrap.packages["node_modules/shared"]?.version).toBe("1.0.0");
    expect(shrinkwrap.packages["node_modules/gamma/node_modules/shared"]?.version).toBe("2.0.0");
    expect(paths(shrinkwrap).filter((path) => path.endsWith("/shared"))).toHaveLength(2);
  });

  it("keeps the version the root asks for at the top, even when it is the minority", () => {
    const shrinkwrap = build({ ...rootDependencies, shared: "2.0.0" });
    expect(shrinkwrap.packages["node_modules/shared"]?.version).toBe("2.0.0");
    expect(shrinkwrap.packages["node_modules/alpha/node_modules/shared"]?.version).toBe("1.0.0");
    expect(shrinkwrap.packages["node_modules/beta/node_modules/shared"]?.version).toBe("1.0.0");
    expect(shrinkwrap.packages["node_modules/gamma/node_modules/shared"]).toBeUndefined();
    expect(verifyShrinkwrap(shrinkwrap, mini, IMPORTERS)).toEqual([]);
  });

  it("breaks a tie with the highest version", () => {
    const text = mini
      .replace(
        "  beta@1.0.0:\n    dependencies:\n      shared: 1.0.0\n",
        "  beta@1.0.0:\n    dependencies:\n      shared: 2.0.0\n",
      )
      .replace("  gamma@1.0.0:\n    dependencies:\n      shared: 2.0.0\n", "  gamma@1.0.0: {}\n");
    const shrinkwrap = build(rootDependencies, productionClosure(text, IMPORTERS));
    expect(shrinkwrap.packages["node_modules/shared"]?.version).toBe("2.0.0");
    expect(shrinkwrap.packages["node_modules/alpha/node_modules/shared"]?.version).toBe("1.0.0");
  });

  it("places a dependent's nested copies before its children resolve (hand-made conflict)", () => {
    const entry = (name: string, version: string) =>
      `  ${name}@${version}:\n    resolution: {integrity: sha512-${name}${version}}\n`;
    const lock = `lockfileVersion: '9.0'
importers:
  apps/daemon:
    dependencies:
      x: {specifier: 1.0.0, version: 1.0.0}
      a: {specifier: 1.0.0, version: 1.0.0}
      p: {specifier: 1.0.0, version: 1.0.0}
packages:
${["x@1.0.0", "a@1.0.0", "a@2.0.0", "p@1.0.0", "b@1.0.0", "b@2.0.0"]
  .map((id) => entry(...(id.split("@") as [string, string])))
  .join("")}snapshots:
  x@1.0.0:
    dependencies: {a: 2.0.0, b: 2.0.0}
  a@1.0.0: {}
  a@2.0.0:
    dependencies: {b: 1.0.0}
  p@1.0.0:
    dependencies: {b: 1.0.0}
  b@1.0.0: {}
  b@2.0.0: {}
`;
    const shrinkwrap = buildShrinkwrap({
      name: "pkg",
      version: "1.0.0",
      rootDependencies: { x: "1.0.0", a: "1.0.0", p: "1.0.0" },
      closure: productionClosure(lock, ["apps/daemon"]),
      bundled: [],
      installScripts: [],
    });
    const versions = Object.fromEntries(
      Object.entries(shrinkwrap.packages).map(([path, pkg]) => [path, pkg.version]),
    );
    expect(versions).toMatchObject({
      "node_modules/b": "1.0.0",
      "node_modules/a": "1.0.0",
      "node_modules/x/node_modules/a": "2.0.0",
      "node_modules/x/node_modules/b": "2.0.0",
      "node_modules/x/node_modules/a/node_modules/b": "1.0.0",
    });
    expect(verifyShrinkwrap(shrinkwrap, lock, ["apps/daemon"])).toEqual([]);
  });

  it("writes the root, the bundled package, and every entry with version, resolved and integrity", () => {
    const shrinkwrap = build();
    expect(shrinkwrap).toMatchObject({ name: "pkg", version: "1.2.3", lockfileVersion: 3, requires: true });
    expect(shrinkwrap.packages[""]).toMatchObject({
      name: "pkg",
      version: "1.2.3",
      dependencies: rootDependencies,
    });
    expect(shrinkwrap.packages["node_modules/@pap/contracts"]).toEqual({ version: "0.0.0", inBundle: true });
    for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
      if (path === "" || entry.inBundle === true) continue;
      expect(entry.integrity, path).toMatch(/^sha512-/);
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\/.+\.tgz$/);
    }
  });

  it("keeps optional, os, cpu and libc on the platform package", () => {
    const entry = build().packages["node_modules/@native/linux-x64-glibc"];
    expect(entry).toMatchObject({ optional: true, os: ["linux"], cpu: ["x64"], libc: ["glibc"] });
    expect(build().packages["node_modules/native"]?.optionalDependencies).toEqual({
      "@native/linux-x64-glibc": "1.0.0",
    });
  });

  it("carries hasInstallScript for the allowlist only", () => {
    const shrinkwrap = build();
    expect(shrinkwrap.packages["node_modules/node-pty"]?.hasInstallScript).toBe(true);
    for (const [path, entry] of Object.entries(shrinkwrap.packages))
      if (path !== "node_modules/node-pty") expect(entry.hasInstallScript, path).toBeUndefined();
  });

  it("refuses a root dependency the closure does not hold at that version", () => {
    expect(() => build({ ...rootDependencies, alpha: "9.9.9" })).toThrow(/alpha/);
  });

  it("refuses a bundled package the root does not list", () => {
    const rest = Object.fromEntries(
      Object.entries(rootDependencies).filter(([name]) => name !== "@pap/contracts"),
    );
    expect(() => build(rest)).toThrow(/@pap\/contracts/);
  });

  it("refuses a closure entry that nothing reaches", () => {
    const closure = productionClosure(mini, IMPORTERS);
    const orphan = { ...(find(closure, "beta", "1.0.0") as ClosureEntry), name: "orphan" };
    expect(() => build(rootDependencies, [...closure, orphan])).toThrow(/orphan/);
  });
});

describe("verifyShrinkwrap", () => {
  it("returns no problem for the generated shrinkwrap", () => {
    expect(verifyShrinkwrap(build(), mini, IMPORTERS)).toEqual([]);
  });

  it("reports a changed version", () => {
    const shrinkwrap = clone(build());
    at(shrinkwrap, "node_modules/gamma/node_modules/shared").version = "9.9.9";
    const problems = verifyShrinkwrap(shrinkwrap, mini, IMPORTERS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("node_modules/gamma/node_modules/shared");
  });

  it("reports a version swapped for another real version of the package", () => {
    const shrinkwrap = clone(build());
    at(shrinkwrap, "node_modules/gamma/node_modules/shared").version = "1.0.0";
    expect(verifyShrinkwrap(shrinkwrap, mini, IMPORTERS).length).toBeGreaterThan(0);
  });

  it("reports a changed integrity", () => {
    const shrinkwrap = clone(build());
    at(shrinkwrap, "node_modules/alpha").integrity = "sha512-AAAA";
    const problems = verifyShrinkwrap(shrinkwrap, mini, IMPORTERS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("integrity");
  });

  it("reports a changed resolved URL", () => {
    const shrinkwrap = clone(build());
    at(shrinkwrap, "node_modules/alpha").resolved = "https://example.test/alpha-1.0.0.tgz";
    expect(verifyShrinkwrap(shrinkwrap, mini, IMPORTERS)).toHaveLength(1);
  });

  it("reports a removed entry", () => {
    const shrinkwrap = clone(build());
    delete shrinkwrap.packages["node_modules/gamma/node_modules/shared"];
    const problems = verifyShrinkwrap(shrinkwrap, mini, IMPORTERS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("shared@2.0.0");
  });

  it("reports an extra entry", () => {
    const shrinkwrap = clone(build());
    shrinkwrap.packages["node_modules/extra"] = { version: "1.0.0", resolved: "x", integrity: "sha512-x" };
    const problems = verifyShrinkwrap(shrinkwrap, mini, IMPORTERS);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("node_modules/extra");
  });

  it("reports an edge that no longer resolves to the lockfile's version", () => {
    const shrinkwrap = clone(build());
    at(shrinkwrap, "node_modules/shared").version = "2.0.0";
    at(shrinkwrap, "node_modules/shared").integrity = at(
      shrinkwrap,
      "node_modules/gamma/node_modules/shared",
    ).integrity;
    at(shrinkwrap, "node_modules/shared").resolved = at(
      shrinkwrap,
      "node_modules/gamma/node_modules/shared",
    ).resolved;
    delete shrinkwrap.packages["node_modules/gamma/node_modules/shared"];
    const problems = verifyShrinkwrap(shrinkwrap, mini, IMPORTERS);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/shared/);
  });

  it("reports a root dependency whose top-level copy has another version", () => {
    const shrinkwrap = clone(build({ ...rootDependencies, shared: "2.0.0" }));
    at(shrinkwrap, "").dependencies = { ...at(shrinkwrap, "").dependencies, shared: "1.0.0" };
    expect(verifyShrinkwrap(shrinkwrap, mini, IMPORTERS).join("\n")).toMatch(/shared/);
  });
});
