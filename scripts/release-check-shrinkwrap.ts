import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  PACKAGE_IMPORTERS,
  buildShrinkwrap,
  installScriptsOf,
  productionClosure,
  verifyShrinkwrap,
  type Shrinkwrap,
} from "./npm-shrinkwrap.ts";

const PACKAGE = ".pap-npm/package";
const FILE = `${PACKAGE}/npm-shrinkwrap.json`;
const MAX_LISTED = 20;

/** Runs only when `pnpm build:npm` left a package: its shrinkwrap must exist and equal the lockfile entry by entry. */
export function checkShrinkwrap(root: string, problems: string[]): void {
  if (!existsSync(join(root, PACKAGE))) return;
  if (!existsSync(join(root, FILE))) {
    problems.push(`${FILE} is missing: run pnpm build:npm`);
    return;
  }
  const shrinkwrap = JSON.parse(readFileSync(join(root, FILE), "utf8")) as Shrinkwrap;
  const manifest = JSON.parse(readFileSync(join(root, PACKAGE, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    bundleDependencies?: string[];
  };
  const lock = readFileSync(join(root, "pnpm-lock.yaml"), "utf8");
  const found = verifyShrinkwrap(shrinkwrap, lock, PACKAGE_IMPORTERS);
  if (!isDeepStrictEqual(shrinkwrap.packages[""]?.dependencies, manifest.dependencies))
    found.unshift("the root dependencies differ from the package.json dependencies");
  if (found.length === 0) {
    const regenerated = buildShrinkwrap({
      name: shrinkwrap.name,
      version: shrinkwrap.version,
      rootDependencies: manifest.dependencies ?? {},
      closure: productionClosure(lock, PACKAGE_IMPORTERS),
      bundled: manifest.bundleDependencies ?? [],
      installScripts: installScriptsOf(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
    });
    if (!isDeepStrictEqual(shrinkwrap, regenerated))
      found.push(
        "differs from the shrinkwrap regenerated from pnpm-lock.yaml (a field such as hasInstallScript, optional, os, cpu, libc, dependencies or inBundle)",
      );
  }
  for (const problem of found.slice(0, MAX_LISTED)) problems.push(`${FILE}: ${problem}`);
  if (found.length > MAX_LISTED) problems.push(`${FILE}: ${found.length - MAX_LISTED} more problems`);
}
