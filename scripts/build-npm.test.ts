import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertBundled,
  assertPackageClean,
  buildNpm,
  parseCatalog,
  resolveManifest,
  type PackageJson,
} from "./build-npm.ts";

const SHEBANG = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const repoRoot = join(import.meta.dirname, "..");
const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;
const workspace = readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8");

const manifests = () => ({
  daemon: readJson(join(repoRoot, "apps/daemon/package.json")),
  contracts: readJson(join(repoRoot, "packages/contracts/package.json")),
  piHost: readJson(join(repoRoot, "packages/pi-host/package.json")),
  catalog: parseCatalog(workspace),
});

const EXACT = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

describe("resolveManifest", () => {
  it("resolves the real manifests to exact versions with no catalog: or workspace: string", () => {
    const manifest = resolveManifest(manifests());
    expect(JSON.stringify(manifest)).not.toMatch(/catalog:|workspace:/);
    const entries = Object.entries(manifest.dependencies ?? {});
    expect(entries.length).toBeGreaterThan(5);
    for (const [name, version] of entries) expect(version, name).toMatch(EXACT);
    expect(manifest.dependencies?.["@earendil-works/pi-coding-agent"]).toBe("1.1.0");
  });

  it("bundles exactly the two workspace packages, each also pinned in dependencies (npm bundles only those)", () => {
    const input = manifests();
    const manifest = resolveManifest(input);
    expect(manifest.bundleDependencies).toEqual(["@pap/contracts", "@pap/pi-host"]);
    expect(Object.keys(manifest.dependencies ?? {}).filter((name) => name.startsWith("@pap/"))).toEqual([
      "@pap/contracts",
      "@pap/pi-host",
    ]);
    expect(manifest.dependencies?.["@pap/contracts"]).toBe(input.contracts.version);
    expect(manifest.dependencies?.["@pap/pi-host"]).toBe(input.piHost.version);
  });

  it("lists zod 4.6.5 once, however many manifests declare it", () => {
    const manifest = resolveManifest(manifests());
    expect(manifest.dependencies?.zod).toBe("4.6.5");
    expect(JSON.stringify(manifest).match(/"zod"/g)).toHaveLength(1);
  });

  it("sets bin, engines, type, name and version exactly, and no scripts", () => {
    const input = manifests();
    const manifest = resolveManifest(input);
    expect(manifest.name).toBe("@soulkyu/pi-agentic-platform");
    expect(manifest.version).toBe(input.daemon.version);
    expect(manifest.type).toBe("module");
    expect(manifest.bin).toEqual({ pap: "./apps/daemon/dist/main.js" });
    expect(manifest.engines).toEqual({ node: ">=24.14 <25" });
    expect(manifest.license).toBeTruthy();
    expect(manifest.repository).toBeTruthy();
    expect(manifest).not.toHaveProperty("scripts");
    expect(manifest).not.toHaveProperty("devDependencies");
    expect(manifest).not.toHaveProperty("private");
    expect(Object.keys(manifest).sort()).toEqual(
      [
        "bin",
        "bundleDependencies",
        "dependencies",
        "engines",
        "license",
        "name",
        "repository",
        "type",
        "version",
      ].sort(),
    );
  });

  it("takes the package name from the argument", () => {
    expect(resolveManifest({ ...manifests(), name: "@x/y" }).name).toBe("@x/y");
  });

  it("refuses a version conflict between two manifests and names the package", () => {
    const input = manifests();
    input.contracts.dependencies = { ...input.contracts.dependencies, zod: "4.6.4" };
    expect(() => resolveManifest(input)).toThrow(/zod/);
  });

  it("refuses a catalog entry that does not exist, naming the package", () => {
    const input = manifests();
    input.catalog = {};
    expect(() => resolveManifest(input)).toThrow(/@earendil-works\/pi-coding-agent/);
  });

  it("refuses a range, a tag and an url as a version", () => {
    for (const bad of ["^1.2.3", "latest", "github:a/b", "~1.0.0", "1.2"]) {
      const input = manifests();
      input.daemon.dependencies = { ...input.daemon.dependencies, thing: bad };
      expect(() => resolveManifest(input), bad).toThrow(/thing/);
    }
  });
});

describe("parseCatalog", () => {
  it("reads quoted and bare names and ignores the other keys", () => {
    const text =
      'packages:\n  - apps/*\ncatalog:\n  "@a/b": 1.2.3\n  c: 4.5.6-rc.1 # note\nminimumReleaseAge: 4320\n';
    expect(parseCatalog(text)).toEqual({ "@a/b": "1.2.3", c: "4.5.6-rc.1" });
  });

  it("reads the real workspace file", () => {
    expect(parseCatalog(workspace)["@earendil-works/pi-ai"]).toMatch(EXACT);
  });
});

interface Fixture {
  repo: string;
  out: string;
}

const fixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "pap-npm-"));
  roots.push(root);
  const repo = join(root, "repo");
  put(join(repo, "pnpm-workspace.yaml"), workspace);
  put(join(repo, "pnpm-lock.yaml"), readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8"));
  put(join(repo, "LICENSE"), readFileSync(join(repoRoot, "LICENSE"), "utf8"));
  put(join(repo, "package.json"), readFileSync(join(repoRoot, "package.json"), "utf8"));
  for (const dir of ["apps/daemon", "packages/contracts", "packages/pi-host"]) {
    const source = join(repoRoot, dir, "package.json");
    put(join(repo, dir, "package.json"), readFileSync(source, "utf8"));
  }
  put(join(repo, "apps/daemon/dist/main.js"), `${SHEBANG}\nexport {};\n`);
  chmodSync(join(repo, "apps/daemon/dist/main.js"), 0o664);
  put(join(repo, "apps/daemon/dist/lib/x.js"), "export const x = 1;\n");
  put(join(repo, "apps/web/dist/index.html"), "<!doctype html>\n");
  put(join(repo, "packages/contracts/dist/index.js"), "export {};\n");
  put(join(repo, "packages/pi-host/dist/main.js"), "export {};\n");
  put(join(repo, "packages/pi-host/dist/helper/main.js"), "export {};\n");
  return { repo, out: join(root, "out") };
};

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

describe("buildNpm", () => {
  it("writes the package layout the daemon expects", async () => {
    const { repo, out } = fixture();
    const pkg = await buildNpm({ repo, out });
    expect(pkg).toBe(join(out, "package"));
    expect(filesUnder(pkg)).toEqual([
      "LICENSE",
      "apps/daemon/dist/lib/x.js",
      "apps/daemon/dist/main.js",
      "apps/daemon/package.json",
      "apps/web/dist/index.html",
      "node_modules/@pap/contracts/dist/index.js",
      "node_modules/@pap/contracts/package.json",
      "node_modules/@pap/pi-host/dist/helper/main.js",
      "node_modules/@pap/pi-host/dist/main.js",
      "node_modules/@pap/pi-host/package.json",
      "npm-shrinkwrap.json",
      "package.json",
    ]);
  });

  it("writes bundled manifests that resolve with no catalog:, workspace: or src condition", async () => {
    const { repo, out } = fixture();
    const pkg = await buildNpm({ repo, out });
    for (const name of ["contracts", "pi-host"]) {
      const text = readFileSync(join(pkg, "node_modules/@pap", name, "package.json"), "utf8");
      expect(text).not.toMatch(/catalog:|workspace:|development|"src|scripts|private/);
      for (const version of Object.values((JSON.parse(text) as PackageJson).dependencies ?? {})) {
        expect(version).toMatch(EXACT);
      }
    }
    const piHost = readJson(join(pkg, "node_modules/@pap/pi-host/package.json"));
    expect(piHost.exports).toEqual({
      ".": { default: "./dist/main.js" },
      "./helper": { default: "./dist/helper/main.js" },
    });
  });

  it("keeps the shebang line and sets the bin to 0755", async () => {
    const { repo, out } = fixture();
    const pkg = await buildNpm({ repo, out });
    const main = join(pkg, "apps/daemon/dist/main.js");
    expect(readFileSync(main, "utf8").split("\n")[0]).toBe(SHEBANG);
    expect(statSync(main).mode & 0o777).toBe(0o755);
  });

  it("refuses a bin target without the shebang line", async () => {
    const { repo, out } = fixture();
    put(join(repo, "apps/daemon/dist/main.js"), "export {};\n");
    await expect(buildNpm({ repo, out })).rejects.toThrow(/shebang/);
  });

  it("does not copy test files or source maps", async () => {
    const { repo, out } = fixture();
    put(join(repo, "apps/daemon/dist/lib/x.test.js"), "export {};\n");
    put(join(repo, "apps/daemon/dist/lib/x.test.d.ts"), "export {};\n");
    put(join(repo, "apps/daemon/dist/lib/x.js.map"), "{}\n");
    put(join(repo, "packages/pi-host/dist/helper/y.test.js"), "export {};\n");
    const pkg = await buildNpm({ repo, out });
    expect(filesUnder(pkg).filter((file) => /\.test\.|\.map$/.test(file))).toEqual([]);
  });

  it("refuses a staged .npmrc holding a token, naming the file and not the value", async () => {
    const { repo, out } = fixture();
    put(
      join(repo, "apps/daemon/dist/.npmrc"),
      "//registry.npmjs.org/:_authToken=npm_SECRETSECRETSECRETSECRET\n",
    );
    const error = await buildNpm({ repo, out }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/\.npmrc/);
    expect((error as Error).message).not.toContain("SECRET");
  });

  it("refuses any .npmrc, even without a token", async () => {
    const { repo, out } = fixture();
    put(join(repo, "apps/web/dist/.npmrc"), "engine-strict=true\n");
    await expect(buildNpm({ repo, out })).rejects.toThrow(/\.npmrc/);
  });

  it("refuses a package.json in the copied dist that holds a credential", async () => {
    const { repo, out } = fixture();
    put(join(repo, "packages/contracts/dist/vendor/package.json"), '{"x":"_authToken=abc"}\n');
    await expect(buildNpm({ repo, out })).rejects.toThrow(/credential/);
    expect(existsSync(join(out, "package"))).toBe(false);
  });

  it("refuses a file that names the package directory or the builder home", async () => {
    const { repo, out } = fixture();
    put(join(repo, "apps/web/dist/index.html"), `<!-- ${join(out, "package")} -->\n`);
    await expect(buildNpm({ repo, out })).rejects.toThrow(/build directory/);
    const second = fixture();
    put(join(second.repo, "apps/web/dist/index.html"), "<!-- /home/builder/x -->\n");
    await expect(buildNpm({ ...second, home: "/home/builder" })).rejects.toThrow(/build directory/);
  });

  it("refuses a symlink in a dist folder", async () => {
    const { repo, out } = fixture();
    symlinkSync("/etc/passwd", join(repo, "apps/web/dist/link"));
    await expect(buildNpm({ repo, out })).rejects.toThrow(/symlink/);
  });

  it("refuses a missing dist folder before it writes anything", async () => {
    const { repo, out } = fixture();
    rmSync(join(repo, "packages/pi-host/dist"), { recursive: true });
    await expect(buildNpm({ repo, out })).rejects.toThrow(/packages\/pi-host\/dist.*pnpm build/);
    expect(existsSync(out)).toBe(false);
  });

  it("replaces a previous build in the same folder", async () => {
    const { repo, out } = fixture();
    await buildNpm({ repo, out });
    put(join(out, "package/stale.txt"), "old");
    const pkg = await buildNpm({ repo, out });
    expect(existsSync(join(pkg, "stale.txt"))).toBe(false);
  });

  it("writes a package.json with no credential and no scripts", async () => {
    const { repo, out } = fixture();
    const pkg = await buildNpm({ repo, out });
    const text = readFileSync(join(pkg, "package.json"), "utf8");
    expect(text).not.toMatch(/_authToken|_password|scripts|catalog:|workspace:/);
  });
});

describe("build roots (M6b-C5)", () => {
  it("no pap source file names the default build folder", () => {
    const hits: string[] = [];
    for (const parent of ["apps", "packages"]) {
      for (const entry of readdirSync(join(repoRoot, parent), { withFileTypes: true })) {
        const src = join(repoRoot, parent, entry.name, "src");
        if (!existsSync(src)) continue;
        for (const file of readdirSync(src, { recursive: true, withFileTypes: true })) {
          if (!file.isFile() || !/\.(ts|js|tsx)$/.test(file.name)) continue;
          const path = join(file.parentPath, file.name);
          if (readFileSync(path, "utf8").includes(".pap-npm")) hits.push(path);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("final package scans (independent of the copy)", () => {
  const folder = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "pap-npm-scan-"));
    roots.push(dir);
    put(join(dir, "package.json"), "{}");
    return dir;
  };

  it("refuses a test file or a map that reached the folder", () => {
    for (const name of ["a.test.js", "a.js.map"]) {
      const dir = folder();
      put(join(dir, "apps/daemon/dist", name), "x");
      expect(() => assertPackageClean(dir), name).toThrow(/test file or a map/);
    }
  });

  it("refuses a .gitignore or .npmignore anywhere", () => {
    for (const name of [".gitignore", ".npmignore"]) {
      const dir = folder();
      put(join(dir, "apps/web/dist", name), "*\n");
      expect(() => assertPackageClean(dir), name).toThrow(/what npm pack ships/);
    }
  });

  it("refuses a .gitignore in a copied dist through buildNpm", async () => {
    const { repo, out } = fixture();
    put(join(repo, "apps/web/dist/.gitignore"), "*\n");
    await expect(buildNpm({ repo, out })).rejects.toThrow(/\.gitignore/);
  });

  const bundledFolder = (version: string | undefined): string => {
    const dir = folder();
    put(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@pap/contracts": "0.0.0" }, bundleDependencies: ["@pap/contracts"] }),
    );
    if (version !== undefined) {
      put(join(dir, "node_modules/@pap/contracts/package.json"), JSON.stringify({ version }));
    }
    return dir;
  };

  it("accepts bundled copies whose version equals the dependencies entry", () => {
    expect(() => assertBundled(bundledFolder("0.0.0"))).not.toThrow();
  });

  it("refuses a missing bundled copy, naming the package", () => {
    expect(() => assertBundled(bundledFolder(undefined))).toThrow(/@pap\/contracts/);
  });

  it("refuses a bundled copy with another version", () => {
    expect(() => assertBundled(bundledFolder("0.0.1"))).toThrow(/@pap\/contracts/);
  });

  it("buildNpm refuses a bundled package with no version and writes no package folder", async () => {
    const { repo, out } = fixture();
    const file = join(repo, "packages/contracts/package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as PackageJson;
    delete manifest.version;
    writeFileSync(file, JSON.stringify(manifest));
    await expect(buildNpm({ repo, out })).rejects.toThrow(/@pap\/contracts/);
    expect(existsSync(join(out, "package"))).toBe(false);
  });

  it("buildNpm leaves no staging folder behind", async () => {
    const { repo, out } = fixture();
    await buildNpm({ repo, out });
    expect(readdirSync(out)).toEqual(["package"]);
  });
});
