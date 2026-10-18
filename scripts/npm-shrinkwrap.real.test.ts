import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseCatalog, parseLockScope, resolveManifest, type PackageJson } from "./build-npm.ts";
import {
  PACKAGE_IMPORTERS as REAL_IMPORTERS,
  buildShrinkwrap,
  installScriptsOf,
  productionClosure,
  verifyShrinkwrap,
  type ClosureEntry,
  type Shrinkwrap,
} from "./npm-shrinkwrap.ts";

const real = readFileSync(join(import.meta.dirname, "..", "pnpm-lock.yaml"), "utf8");

describe("the real pnpm-lock.yaml", () => {
  const root = join(import.meta.dirname, "..");
  const readJson = (path: string): PackageJson =>
    JSON.parse(readFileSync(join(root, path), "utf8")) as PackageJson;
  const workspace = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8");
  const catalog = parseCatalog(workspace);
  const manifest = resolveManifest({
    daemon: readJson("apps/daemon/package.json"),
    contracts: readJson("packages/contracts/package.json"),
    piHost: readJson("packages/pi-host/package.json"),
    catalog,
    pinned: parseLockScope(real),
  });
  let closure: ClosureEntry[];
  let shrinkwrap: Shrinkwrap;
  beforeAll(() => {
    closure = productionClosure(real, REAL_IMPORTERS);
    shrinkwrap = buildShrinkwrap({
      name: "pkg",
      version: "0.0.0",
      rootDependencies: manifest.dependencies ?? {},
      closure,
      bundled: ["@pap/contracts", "@pap/pi-host"],
      installScripts: installScriptsOf(workspace),
    });
  });

  it("the production closure has no diverging peer variants today", () => {
    expect(() => productionClosure(real, REAL_IMPORTERS)).not.toThrow();
    expect(closure.length).toBeGreaterThan(100);
  });

  it("hasInstallScript is exactly onlyBuiltDependencies, and each is in the closure", () => {
    const allowed = installScriptsOf(workspace);
    expect(allowed).toEqual(["node-pty"]);
    for (const name of allowed)
      expect(
        closure.some((entry) => entry.name === name),
        name,
      ).toBe(true);
    const flagged = Object.entries(shrinkwrap.packages)
      .filter(([, entry]) => entry.hasInstallScript === true)
      .map(([path]) => path.slice(path.lastIndexOf("node_modules/") + 13));
    expect(flagged).toEqual(allowed);
  });

  it("pins the Pi SDK packages to the catalog version", () => {
    for (const name of ["pi-coding-agent", "pi-ai", "pi-tui"]) {
      expect(shrinkwrap.packages[`node_modules/@earendil-works/${name}`]?.version, name).toBe(
        catalog[`@earendil-works/${name}`],
      );
    }
  });

  it("has no two versions of one @earendil-works package at the top level and the lockfile has one", () => {
    const top = Object.keys(shrinkwrap.packages).filter((path) =>
      /^node_modules\/@earendil-works\/[^/]+$/.test(path),
    );
    expect(top.length).toBeGreaterThanOrEqual(8);
    for (const path of top) {
      const name = path.slice("node_modules/".length);
      const versions = closure.filter((entry) => entry.name === name).map((entry) => entry.version);
      expect(versions, name).toEqual([shrinkwrap.packages[path]?.version]);
    }
  });

  it("the daemon's own pins win at the top level", () => {
    for (const name of ["yaml", "ws", "zod", "hono"])
      expect(shrinkwrap.packages[`node_modules/${name}`]?.version, name).toBe(manifest.dependencies?.[name]);
  });

  it("round-trips against the lockfile", () => {
    expect(verifyShrinkwrap(shrinkwrap, real, REAL_IMPORTERS)).toEqual([]);
  });

  it("every entry has an integrity and a registry URL", () => {
    for (const [path, entry] of Object.entries(shrinkwrap.packages)) {
      if (path === "" || entry.inBundle === true) continue;
      expect(entry.integrity, path).toMatch(/^sha512-/);
      expect(entry.resolved, path).toMatch(/^https:\/\/registry\.npmjs\.org\//);
    }
  });
});
