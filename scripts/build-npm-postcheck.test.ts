import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./npm-shrinkwrap.ts", async (importOriginal) => {
  const real = await importOriginal<typeof import("./npm-shrinkwrap.ts")>();
  return {
    ...real,
    buildShrinkwrap: (input: Parameters<typeof real.buildShrinkwrap>[0]) => {
      const shrinkwrap = real.buildShrinkwrap(input);
      const target = shrinkwrap.packages["node_modules/zod"];
      if (target !== undefined) target.integrity = "sha512-tampered";
      return shrinkwrap;
    },
  };
});

const { buildNpm } = await import("./build-npm.ts");
const repoRoot = join(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

describe("the builder's post-check", () => {
  it("throws and packs nothing when the shrinkwrap it built differs from the lockfile", async () => {
    const root = mkdtempSync(join(tmpdir(), "pap-npm-post-"));
    roots.push(root);
    const repo = join(root, "repo");
    for (const file of [
      "package.json",
      "pnpm-workspace.yaml",
      "pnpm-lock.yaml",
      "apps/daemon/package.json",
      "packages/contracts/package.json",
      "packages/pi-host/package.json",
    ])
      put(join(repo, file), readFileSync(join(repoRoot, file), "utf8"));
    put(
      join(repo, "apps/daemon/dist/main.js"),
      "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning\nexport {};\n",
    );
    put(join(repo, "apps/web/dist/index.html"), "<!doctype html>\n");
    put(join(repo, "packages/contracts/dist/index.js"), "export {};\n");
    put(join(repo, "packages/pi-host/dist/main.js"), "export {};\n");
    const out = join(root, "out");
    await expect(buildNpm({ repo, out })).rejects.toThrow(/shrinkwrap differs from pnpm-lock\.yaml.*zod/);
    expect(existsSync(join(out, "package"))).toBe(false);
  });
});
