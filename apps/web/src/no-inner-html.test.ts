import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../../..");
const ROOTS = ["packages/ui/src", "apps/web/src"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.(?:ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

const files = ROOTS.flatMap((root) => sources(join(repoRoot, root))).map((path) => ({
  path: relative(repoRoot, path),
  text: readFileSync(path, "utf8"),
}));

// UX2-R48, decision 139: model text reaches pap's DOM as markup in one place only, KaTeX's own escaped output. A diagram
// is an <img> of a blob: URL (MermaidBlock), an HTML artifact lives in a sandboxed frame of the untrusted origin.
describe("markup written into pap's DOM", () => {
  it("dangerouslySetInnerHTML appears in MathBlock.tsx and nowhere else", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(
      files.filter((file) => file.text.includes("dangerouslySetInnerHTML")).map((file) => file.path),
    ).toEqual(["packages/ui/src/ai/markdown/MathBlock.tsx"]);
  });

  it("no other route writes markup either", () => {
    const writes = /\.(?:innerHTML|outerHTML)\s*=|insertAdjacentHTML\s*\(|document\.write\s*\(|\bsrcdoc\b/u;
    expect(files.filter((file) => writes.test(file.text)).map((file) => file.path)).toEqual([]);
  });
});
