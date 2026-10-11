import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function bumpCatalog(yaml: string): string {
  return yaml.replace(/^([ \t]+"@earendil-works\/[^"]+":[ \t]*)[^\s#]+([ \t]+#.*)?$/gm, "$1latest$2");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = "pnpm-workspace.yaml";
  const before = readFileSync(path, "utf8");
  const after = bumpCatalog(before);
  if (after === before) {
    console.error(`pi-compat-bump: no @earendil-works catalog line changed in ${path}`);
    process.exitCode = 1;
  } else {
    writeFileSync(path, after);
  }
}
