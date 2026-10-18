import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { putLicences } from "./licence-fixture.ts";
import {
  assertBundled,
  assertBundledDependencies,
  buildNpm,
  parseCatalog,
  parseLockScope,
  resolveManifest,
  type PackageJson,
} from "./build-npm.ts";

const repoRoot = join(import.meta.dirname, "..");
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pap-npm-pkg-"));
  roots.push(dir);
  return dir;
};
const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const readJson = (path: string): PackageJson => JSON.parse(readFileSync(path, "utf8")) as PackageJson;
const lock = readFileSync(join(repoRoot, "pnpm-lock.yaml"), "utf8");
const catalog = parseCatalog(readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
const input = () => ({
  daemon: readJson(join(repoRoot, "apps/daemon/package.json")),
  contracts: readJson(join(repoRoot, "packages/contracts/package.json")),
  piHost: readJson(join(repoRoot, "packages/pi-host/package.json")),
  catalog,
});

const SHEBANG = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";
// the same lookup as kernel/version.ts, which reads the daemon's package.json from dist/kernel
const VERSION_JS =
  'import { createRequire } from "node:module";\nexport const VERSION = createRequire(import.meta.url)("../../package.json").version;\n';

const fakeRepo = (): { repo: string; out: string } => {
  const root = tmp();
  const repo = join(root, "repo");
  put(join(repo, "pnpm-workspace.yaml"), readFileSync(join(repoRoot, "pnpm-workspace.yaml"), "utf8"));
  put(join(repo, "pnpm-lock.yaml"), lock);
  putLicences(repo);
  put(join(repo, "package.json"), readFileSync(join(repoRoot, "package.json"), "utf8"));
  for (const dir of ["apps/daemon", "packages/contracts", "packages/pi-host"])
    put(join(repo, dir, "package.json"), readFileSync(join(repoRoot, dir, "package.json"), "utf8"));
  put(
    join(repo, "apps/daemon/dist/main.js"),
    `${SHEBANG}\nimport { VERSION } from "./kernel/version.js";\nconsole.log(VERSION);\n`,
  );
  put(join(repo, "apps/daemon/dist/kernel/version.js"), VERSION_JS);
  put(join(repo, "apps/web/dist/index.html"), "<!doctype html>\n");
  put(join(repo, "packages/contracts/dist/index.js"), "export {};\n");
  put(join(repo, "packages/pi-host/dist/main.js"), "export {};\n");
  return { repo, out: join(root, "out") };
};

describe("D1: bundled packages carry no dependencies", () => {
  it("the bundled copies written by buildNpm have no dependencies field", async () => {
    const { repo, out } = fakeRepo();
    const pkg = await buildNpm({ repo, out });
    for (const name of ["contracts", "pi-host"])
      expect(readJson(join(pkg, "node_modules/@pap", name, "package.json"))).not.toHaveProperty(
        "dependencies",
      );
  });

  it("assertBundled refuses a bundled copy that declares dependencies", () => {
    const dir = tmp();
    put(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { "@pap/contracts": "0.0.0" }, bundleDependencies: ["@pap/contracts"] }),
    );
    put(
      join(dir, "node_modules/@pap/contracts/package.json"),
      JSON.stringify({ version: "0.0.0", dependencies: { zod: "4.6.5" } }),
    );
    expect(() => assertBundled(dir)).toThrow(/declares dependencies/);
  });

  it("refuses a dependency of a bundled package that the root does not list", () => {
    const manifest = resolveManifest(input());
    const rest = Object.fromEntries(
      Object.entries(manifest.dependencies ?? {}).filter(([name]) => name !== "zod"),
    );
    expect(() =>
      assertBundledDependencies({ ...manifest, dependencies: rest }, [input().contracts], catalog),
    ).toThrow(/zod/);
  });

  it("refuses a dependency of a bundled package listed with another version", () => {
    const manifest = resolveManifest(input());
    const dependencies = { ...manifest.dependencies, zod: "0.0.1" };
    expect(() =>
      assertBundledDependencies({ ...manifest, dependencies }, [input().contracts], catalog),
    ).toThrow(/zod/);
  });

  it("accepts the real manifests", () => {
    const { contracts, piHost } = input();
    expect(() =>
      assertBundledDependencies(resolveManifest(input()), [contracts, piHost], catalog),
    ).not.toThrow();
  });
});

describe("D2: the daemon's package.json ships", () => {
  it("writes apps/daemon/package.json with the name, version and type, and no scripts", async () => {
    const { repo, out } = fakeRepo();
    const pkg = await buildNpm({ repo, out });
    const daemon = readJson(join(repoRoot, "apps/daemon/package.json"));
    expect(readJson(join(pkg, "apps/daemon/package.json"))).toEqual({
      name: daemon.name,
      version: daemon.version,
      type: daemon.type,
    });
  });

  it("kernel/version.ts still reads ../../package.json (the fixture's copy of that lookup)", () => {
    expect(readFileSync(join(repoRoot, "apps/daemon/src/kernel/version.ts"), "utf8")).toContain(
      '"../../package.json"',
    );
  });

  it("the built package folder boots offline: the version lookup finds its package.json", async () => {
    const { repo, out } = fakeRepo();
    const pkg = await buildNpm({ repo, out });
    const run = spawnSync(process.execPath, [join(pkg, "apps/daemon/dist/main.js")], { encoding: "utf8" });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe(readJson(join(repoRoot, "apps/daemon/package.json")).version);
  });

  // The real daemon, from the package folder, with the workspace's resolved dependencies linked in (no network).
  it.runIf(
    existsSync(join(repoRoot, "apps/daemon/dist/main.js")) && existsSync(join(repoRoot, "apps/web/dist")),
  )("the real built package starts a command with the workspace's dependencies linked in", async () => {
    const out = tmp();
    const pkg = await buildNpm({ repo: repoRoot, out });
    for (const from of ["apps/daemon", "packages/pi-host"]) {
      const base = join(repoRoot, from, "node_modules");
      for (const entry of readdirSync(base)) {
        if (entry === "@pap" || entry === ".bin") continue;
        const target = join(pkg, "node_modules", entry);
        if (entry.startsWith("@")) {
          mkdirSync(target, { recursive: true });
          for (const child of readdirSync(join(base, entry)))
            if (!existsSync(join(target, child))) symlinkSync(join(base, entry, child), join(target, child));
        } else if (!existsSync(target)) symlinkSync(join(base, entry), target);
      }
    }
    const run = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", join(pkg, "apps/daemon/dist/main.js"), "doctor", "--help"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", HOME: out },
      },
    );
    expect(run.stderr).not.toContain("Cannot find module");
    expect(run.status).toBe(0);
  });
});

describe("D3: the Pi SDK siblings are pinned to the lockfile", () => {
  it("parseLockScope reads the packages section only", () => {
    const text =
      "packages:\n\n  '@earendil-works/a@1.1.0':\n    resolution: {}\n  '@other/b@2.0.0':\n    x: 1\n\nsnapshots:\n\n  '@earendil-works/c@9.9.9':\n    dependencies: {}\n";
    expect(parseLockScope(text)).toEqual({ "@earendil-works/a": "1.1.0" });
  });

  it("refuses two different versions of one package, naming both", () => {
    const text =
      "packages:\n\n  '@earendil-works/a@1.1.0':\n    x: 1\n  '@earendil-works/a@1.3.0':\n    x: 1\n";
    expect(() => parseLockScope(text)).toThrow(/@earendil-works\/a.*1\.1\.0.*1\.3\.0/);
    const same =
      "packages:\n  '@earendil-works/a@1.1.0':\n    x: 1\n  '@earendil-works/a@1.1.0':\n    x: 1\n";
    expect(parseLockScope(same)).toEqual({ "@earendil-works/a": "1.1.0" });
  });

  it("the real lockfile gives every @earendil-works package, and the manifest lists each at that version", () => {
    const pinned = parseLockScope(lock);
    expect(Object.keys(pinned).length).toBeGreaterThanOrEqual(8);
    for (const name of ["pi-codemode", "pi-telemetry", "pi-mcp", "chord", "pi-agent-core"])
      expect(pinned).toHaveProperty(`@earendil-works/${name}`);
    const manifest = resolveManifest({ ...input(), pinned });
    for (const [name, version] of Object.entries(pinned))
      expect(manifest.dependencies?.[name], name).toBe(version);
  });

  it("refuses a pinned version that contradicts the manifests", () => {
    expect(() => resolveManifest({ ...input(), pinned: { "@earendil-works/pi-ai": "1.3.0" } })).toThrow(
      /pi-ai/,
    );
  });

  it("buildNpm writes them into the root dependencies, from the lockfile", async () => {
    const { repo, out } = fakeRepo();
    const pkg = await buildNpm({ repo, out });
    const deps = readJson(join(pkg, "package.json")).dependencies ?? {};
    for (const [name, version] of Object.entries(parseLockScope(lock)))
      expect(deps[name], name).toBe(version);
  });

  it("buildNpm ships the licence texts, and refuses a repository without one", async () => {
    const ok = fakeRepo();
    const pkg = await buildNpm(ok);
    for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "LICENSES/Apache-2.0.txt"])
      expect(existsSync(join(pkg, file)), file).toBe(true);
    const bare = fakeRepo();
    rmSync(join(bare.repo, "LICENSES"), { recursive: true });
    await expect(buildNpm(bare)).rejects.toThrow(/LICENSES/);
    expect(existsSync(join(bare.out, "package"))).toBe(false);
  });

  it("buildNpm refuses a missing lockfile or one without the Pi SDK, and packs nothing", async () => {
    const a = fakeRepo();
    rmSync(join(a.repo, "pnpm-lock.yaml"));
    await expect(buildNpm(a)).rejects.toThrow(/pnpm-lock\.yaml/);
    const b = fakeRepo();
    writeFileSync(join(b.repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\npackages:\n");
    await expect(buildNpm(b)).rejects.toThrow(/@earendil-works/);
    expect(existsSync(join(b.out, "package"))).toBe(false);
  });
});
