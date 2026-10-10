import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function copySql(packageRoot: string): string[] {
  const src = join(packageRoot, "src");
  const copied: string[] = [];
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".sql")) continue;
    const from = join(entry.parentPath, entry.name);
    const rel = relative(src, from);
    if (!rel.split(sep).includes("migrations")) continue;
    const to = join(packageRoot, "dist", rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
    copied.push(rel.split(sep).join("/"));
  }
  return copied.sort();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) copySql(process.cwd());
