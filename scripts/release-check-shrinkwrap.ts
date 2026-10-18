import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PACKAGE_IMPORTERS, verifyShrinkwrap, type Shrinkwrap } from "./npm-shrinkwrap.ts";

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
  };
  const found = verifyShrinkwrap(
    shrinkwrap,
    readFileSync(join(root, "pnpm-lock.yaml"), "utf8"),
    PACKAGE_IMPORTERS,
  );
  if (!isDeepStrictEqual(shrinkwrap.packages[""]?.dependencies, manifest.dependencies))
    found.unshift("the root dependencies differ from the package.json dependencies");
  for (const problem of found.slice(0, MAX_LISTED)) problems.push(`${FILE}: ${problem}`);
  if (found.length > MAX_LISTED) problems.push(`${FILE}: ${found.length - MAX_LISTED} more problems`);
}
