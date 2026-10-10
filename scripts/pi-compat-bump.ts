import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export function bumpCatalog(yaml: string): string {
  return yaml.replace(/^(\s+"@earendil-works\/[^"]+":\s*)\S+$/gm, "$1latest");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = "pnpm-workspace.yaml";
  writeFileSync(path, bumpCatalog(readFileSync(path, "utf8")));
}
