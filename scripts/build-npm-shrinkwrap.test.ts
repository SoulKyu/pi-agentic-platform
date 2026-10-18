import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { putLicences } from "./licence-fixture.ts";
import { buildNpm, type PackageJson } from "./build-npm.ts";
import { PACKAGE_IMPORTERS, verifyShrinkwrap, type Shrinkwrap } from "./npm-shrinkwrap.ts";

const repoRoot = join(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const copy = (repo: string, file: string) =>
  put(join(repo, file), readFileSync(join(repoRoot, file), "utf8"));
const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T;
const SHEBANG = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";

const fixture = (license?: string, licenseText?: string) => {
  const root = mkdtempSync(join(tmpdir(), "pap-npm-sw-"));
  roots.push(root);
  const repo = join(root, "repo");
  for (const file of [
    "pnpm-workspace.yaml",
    "pnpm-lock.yaml",
    "apps/daemon/package.json",
    "packages/contracts/package.json",
    "packages/pi-host/package.json",
  ])
    copy(repo, file);
  const rootManifest = readJson<PackageJson>(join(repoRoot, "package.json"));
  put(
    join(repo, "package.json"),
    JSON.stringify(license === undefined ? rootManifest : { ...rootManifest, license }),
  );
  // The real manifest is AGPL, so a fixture that keeps it carries the real LICENSE; one that overrides the id brings its own text (or none).
  putLicences(repo);
  if (licenseText !== undefined) put(join(repo, "LICENSE"), licenseText);
  else if (license !== undefined) rmSync(join(repo, "LICENSE"));
  put(join(repo, "apps/daemon/dist/main.js"), `${SHEBANG}\nexport {};\n`);
  put(join(repo, "apps/web/dist/index.html"), "<!doctype html>\n");
  put(join(repo, "packages/contracts/dist/index.js"), "export {};\n");
  put(join(repo, "packages/pi-host/dist/main.js"), "export {};\n");
  return { repo, out: join(root, "out") };
};

describe("the shrinkwrap in the built package", () => {
  it("is written, equals the lockfile, and lists the manifest's dependencies at its root", async () => {
    const { repo, out } = fixture();
    const pkg = await buildNpm({ repo, out });
    const shrinkwrap = readJson<Shrinkwrap>(join(pkg, "npm-shrinkwrap.json"));
    const manifest = readJson<PackageJson>(join(pkg, "package.json"));
    expect(shrinkwrap.packages[""]?.dependencies).toEqual(manifest.dependencies);
    expect(shrinkwrap.name).toBe(manifest.name);
    expect(shrinkwrap.version).toBe(manifest.version);
    const lock = readFileSync(join(repo, "pnpm-lock.yaml"), "utf8");
    expect(verifyShrinkwrap(shrinkwrap, lock, PACKAGE_IMPORTERS)).toEqual([]);
  });

  it("marks the bundled packages inBundle without a registry URL, and pins the Pi SDK to the lockfile", async () => {
    const { repo, out } = fixture();
    const shrinkwrap = readJson<Shrinkwrap>(join(await buildNpm({ repo, out }), "npm-shrinkwrap.json"));
    for (const name of ["contracts", "pi-host"]) {
      const entry = shrinkwrap.packages[`node_modules/@pap/${name}`];
      expect(entry?.inBundle).toBe(true);
      expect(entry).not.toHaveProperty("resolved");
      expect(entry).not.toHaveProperty("integrity");
    }
    const piAi = shrinkwrap.packages["node_modules/@earendil-works/pi-ai"];
    expect(piAi?.version).toBe(
      /pi-ai": ([\d.]+)/.exec(readFileSync(join(repo, "pnpm-workspace.yaml"), "utf8"))?.[1],
    );
  });
});

describe("the licence follows the root package.json", () => {
  it("is UNLICENSED when the root has none", async () => {
    const { repo, out } = fixture();
    const root = readJson<PackageJson>(join(repo, "package.json"));
    delete root.license;
    writeFileSync(join(repo, "package.json"), JSON.stringify(root));
    const pkg = await buildNpm({ repo, out });
    expect(readJson<PackageJson>(join(pkg, "package.json")).license).toBe("UNLICENSED");
    expect(existsSync(join(pkg, "LICENSE"))).toBe(false);
  });

  it("copies an AGPL-3.0 id and ships the LICENSE file", async () => {
    const { repo, out } = fixture("AGPL-3.0-or-later", "GNU AFFERO GENERAL PUBLIC LICENSE\n");
    const pkg = await buildNpm({ repo, out });
    expect(readJson<PackageJson>(join(pkg, "package.json")).license).toBe("AGPL-3.0-or-later");
    expect(readFileSync(join(pkg, "LICENSE"), "utf8")).toBe("GNU AFFERO GENERAL PUBLIC LICENSE\n");
  });

  it("refuses an AGPL-3.0 id without a LICENSE file and packs nothing", async () => {
    const { repo, out } = fixture("AGPL-3.0-only");
    await expect(buildNpm({ repo, out })).rejects.toThrow(/LICENSE/);
    expect(existsSync(join(out, "package"))).toBe(false);
  });
});
