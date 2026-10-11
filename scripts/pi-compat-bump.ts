import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CATALOG_ENTRY = /^([ \t]+"@earendil-works\/[^"]+":[ \t]*)[^\s#]+([ \t]+#.*)?$/gm;

export function catalogEntryCount(yaml: string): number {
  return [...yaml.matchAll(CATALOG_ENTRY)].length;
}

export function bumpCatalog(yaml: string): string {
  return yaml.replace(CATALOG_ENTRY, "$1latest$2");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = "pnpm-workspace.yaml";
  const before = readFileSync(path, "utf8");
  const after = bumpCatalog(before);
  if (catalogEntryCount(before) === 0) {
    // The script or the file shape is broken: a quiet night must not hide it.
    console.error(`pi-compat-bump: no @earendil-works catalog line found in ${path}`);
    process.exitCode = 1;
  } else if (after === before) {
    console.log("pi-compat-bump: every @earendil-works catalog line is already at latest");
  } else {
    writeFileSync(path, after);
    console.log(`pi-compat-bump: bumped the @earendil-works catalog lines to latest in ${path}`);
  }
}
