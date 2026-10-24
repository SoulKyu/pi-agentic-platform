import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  linkSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { putAgentBundle } from "./agent-bundle-fixture.ts";
import { createHash } from "node:crypto";
import {
  AGENT_BUNDLE,
  assertAgentBundle,
  buildAgentBundle,
  copyUnlinked,
  storeRootOf,
} from "./build-agent-bundle.ts";

/*
 * Mutants, each run for real: the link check removed (the four "link" cases); the required-file check removed (the two
 * "missing" cases); the absolute-target refusal removed ("absolute link"); `--offline` dropped from the arguments
 * ("deploys offline"); the previous bundle removed before the new one passed its checks ("keeps the previous bundle").
 */
const roots: string[] = [];
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pap-agent-bundle-"));
  roots.push(dir);
  return dir;
};
const bundleIn = (root: string): string => {
  const bundle = join(root, "bundle");
  putAgentBundle(bundle);
  return bundle;
};

describe("assertAgentBundle", () => {
  it("accepts dist/guest/main.js, dist/relay/main.js and a link that stays inside", () => {
    const bundle = bundleIn(tmp());
    expect(() => assertAgentBundle(bundle)).not.toThrow();
  });

  for (const file of ["dist/guest/main.js", "dist/relay/main.js"])
    it(`refuses a bundle without ${file} (missing)`, () => {
      const bundle = bundleIn(tmp());
      rmSync(join(bundle, file));
      expect(() => assertAgentBundle(bundle)).toThrow(file);
    });

  it("refuses a bundle without a node_modules folder (missing)", () => {
    const bundle = bundleIn(tmp());
    rmSync(join(bundle, "node_modules"), { recursive: true });
    expect(() => assertAgentBundle(bundle)).toThrow(/node_modules/);
  });

  it("refuses a link that leaves the bundle (link)", () => {
    const root = tmp();
    const bundle = bundleIn(root);
    mkdirSync(join(root, "outside"));
    symlinkSync("../../../outside", join(bundle, "node_modules/dep/out"));
    expect(() => assertAgentBundle(bundle)).toThrow(/node_modules\/dep\/out/);
  });

  it("refuses a link that reaches the outside through an inner link (link)", () => {
    const root = tmp();
    const bundle = bundleIn(root);
    mkdirSync(join(root, "outside"));
    symlinkSync("../../../outside", join(bundle, "node_modules/dep/hop"));
    symlinkSync("hop", join(bundle, "node_modules/dep/second"));
    expect(() => assertAgentBundle(bundle)).toThrow(/node_modules\/dep\/hop/);
  });

  it("refuses a dangling link (link)", () => {
    const bundle = bundleIn(tmp());
    symlinkSync("nowhere", join(bundle, "node_modules/dep/dangling"));
    expect(() => assertAgentBundle(bundle)).toThrow(/dangling/);
  });

  it("refuses an absolute link even when it points inside (absolute link)", () => {
    const bundle = bundleIn(tmp());
    symlinkSync(join(bundle, "dist/main.js"), join(bundle, "node_modules/dep/abs"));
    expect(() => assertAgentBundle(bundle)).toThrow(/absolute/);
  });
});

describe("assertAgentBundle: what a build must not leave (leftovers)", () => {
  it("refuses test files, pnpm state, contracts sources and a file that names a forbidden path", () => {
    const bundle = bundleIn(tmp());
    writeFileSync(join(bundle, "node_modules/dep/x.test.js"), "x");
    expect(() => assertAgentBundle(bundle)).toThrow(/test file/);
    rmSync(join(bundle, "node_modules/dep/x.test.js"));
    writeFileSync(join(bundle, "node_modules/.modules.yaml"), "x");
    expect(() => assertAgentBundle(bundle)).toThrow(/builder state/);
    rmSync(join(bundle, "node_modules/.modules.yaml"));
    mkdirSync(join(bundle, "node_modules/@pap/contracts/src"), { recursive: true });
    expect(() => assertAgentBundle(bundle)).toThrow(/source folder/);
    rmSync(join(bundle, "node_modules/@pap/contracts"), { recursive: true });
    writeFileSync(join(bundle, "dist/main.js"), "const p = '/home/builder/x';");
    expect(() => assertAgentBundle(bundle, ["/home/builder"])).toThrow(/dist\/main\.js/);
    expect(() => assertAgentBundle(bundle, ["/home/other"])).not.toThrow();
  });
});

const digestOf = (dir: string): string => {
  const hash = createHash("sha256");
  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true }).sort((a, b) =>
    join(a.parentPath, a.name).localeCompare(join(b.parentPath, b.name)),
  )) {
    const path = join(entry.parentPath, entry.name);
    hash.update(`${path.slice(dir.length)}\0`);
    if (entry.isFile()) hash.update(readFileSync(path));
    else if (entry.isSymbolicLink()) hash.update(readlinkSync(path));
  }
  return hash.digest("hex");
};

describe("buildAgentBundle", () => {
  const setup = () => {
    const repo = tmp();
    const out = join(repo, AGENT_BUNDLE);
    const calls: Array<{ cmd: string; args: readonly string[]; cwd: string }> = [];
    const run =
      (deploy: (dest: string) => void) =>
      (cmd: string, args: readonly string[], cwd: string): Promise<void> => {
        calls.push({ cmd, args, cwd });
        deploy(args.at(-1) ?? "");
        return Promise.resolve();
      };
    return { repo, out, calls, run };
  };

  it("deploys offline from the local store, flat, production only, without touching the release age (deploys offline)", async () => {
    const t = setup();
    await buildAgentBundle({
      repo: t.repo,
      storeDir: "/store",
      run: t.run((dest) => putAgentBundle(dest, { deployed: true })),
    });
    const call = t.calls[0];
    expect(call?.cmd).toBe("pnpm");
    expect(call?.cwd).toBe(t.repo);
    expect(call?.args).toEqual(
      expect.arrayContaining([
        "--filter",
        "@pap/pi-host",
        "deploy",
        "--prod",
        "--offline",
        "--package-import-method=copy",
        "--config.node-linker=hoisted",
        "--store-dir",
        "/store",
      ]),
    );
    expect(call?.args.join(" ")).not.toMatch(/release-age|minimum/i);
    expect(call?.args.at(-1)?.startsWith(join(t.repo, "packages/pi-host"))).toBe(true);
    expect(call?.args.at(-1)).not.toBe(t.out);
  });

  it("leaves dist and node_modules, prunes the sources and the lockfile, and no building folder", async () => {
    const t = setup();
    const out = await buildAgentBundle({
      repo: t.repo,
      storeDir: "/store",
      run: t.run((dest) => putAgentBundle(dest, { deployed: true })),
    });
    expect(out).toBe(t.out);
    expect(readdirSync(t.out).sort()).toEqual(["bin", "dist", "node_modules", "package.json"]);
    expect(existsSync(join(t.out, "dist/guest/main.js"))).toBe(true);
    expect(existsSync(join(t.out, "dist/relay/main.js"))).toBe(true);
    expect(readdirSync(join(t.repo, "packages/pi-host"))).toEqual(["dist-agent"]);
  });

  it("leaves node-pty to the image: the host's build names the repository", async () => {
    const t = setup();
    const out = await buildAgentBundle({
      repo: t.repo,
      storeDir: "/store",
      run: t.run((dest) => {
        putAgentBundle(dest, { deployed: true });
        mkdirSync(join(dest, "node_modules/node-pty/build"), { recursive: true });
        writeFileSync(join(dest, "node_modules/node-pty/build/Makefile"), `srcdir := ${t.repo}\n`);
      }),
    });
    expect(existsSync(join(out, "node_modules/node-pty"))).toBe(false);
  });

  it("cleans pnpm state, sources, tests and builder paths, and two builds from other paths give the same bytes (reproducible)", async () => {
    const digests: string[] = [];
    for (const delay of [1, 2]) {
      const t = setup();
      await new Promise((r) => setTimeout(r, delay));
      const out = await buildAgentBundle({
        repo: t.repo,
        storeDir: "/store",
        run: t.run((dest) => putAgentBundle(dest, { deployed: true })),
      });
      const names = readdirSync(out, { recursive: true }).map(String);
      expect(
        names.filter((n) =>
          /\.test\.|\.spec\.|modules\.yaml|\.pnpm|contracts\/src|tsconfig|dist-agent/.test(n),
        ),
      ).toEqual([]);
      expect(readFileSync(join(out, "package.json"), "utf8")).not.toMatch(/file:|dependencies/);
      expect(existsSync(join(out, "node_modules/@pap/contracts/dist/main.js"))).toBe(true);
      digests.push(digestOf(out));
    }
    expect(digests[1]).toBe(digests[0]);
  });

  it("keeps pnpm's stderr, clipped, in the failure", async () => {
    const t = setup();
    const run = () =>
      Promise.reject(
        Object.assign(new Error("x"), { stderr: `ERR_PNPM_NO_OFFLINE_TARBALL ${"y".repeat(900)}` }),
      );
    const failure = await buildAgentBundle({ repo: t.repo, storeDir: "/store", run }).catch((e: Error) => e);
    expect((failure as Error).message).toMatch(/yyy\)$/);
    expect((failure as Error).message.length).toBeLessThan(600);
  });

  it("replaces the previous bundle", async () => {
    const t = setup();
    putAgentBundle(t.out);
    writeMarker(t.out);
    await buildAgentBundle({
      repo: t.repo,
      storeDir: "/store",
      run: t.run((dest) => putAgentBundle(dest, { deployed: true })),
    });
    expect(existsSync(join(t.out, "marker"))).toBe(false);
  });

  it("keeps the previous bundle when the deploy fails or the result is not a bundle (keeps the previous bundle)", async () => {
    const t = setup();
    putAgentBundle(t.out);
    writeMarker(t.out);
    await expect(
      buildAgentBundle({ repo: t.repo, storeDir: "/store", run: () => Promise.reject(new Error("offline")) }),
    ).rejects.toThrow(/offline|run pnpm install first/);
    await expect(
      buildAgentBundle({
        repo: t.repo,
        storeDir: "/store",
        run: t.run((dest) => {
          putAgentBundle(dest);
          rmSync(join(dest, "dist/relay/main.js"));
        }),
      }),
    ).rejects.toThrow(/dist\/relay\/main\.js/);
    expect(readFileSync(join(t.out, "marker"), "utf8")).toBe("old");
    expect(readdirSync(join(t.repo, "packages/pi-host")).sort()).toEqual(["dist-agent"]);
  });
});

describe("storeRootOf", () => {
  it("strips one trailing version segment, so deploy does not append a second one", () => {
    expect(storeRootOf("/home/u/.local/share/pnpm/store/v11")).toBe("/home/u/.local/share/pnpm/store");
    expect(storeRootOf("/home/u/.local/share/pnpm/store/v3/")).toBe("/home/u/.local/share/pnpm/store");
    expect(storeRootOf("/store/v10/v11")).toBe("/store/v10");
  });
  it("leaves a root without a version and a name that only looks like one", () => {
    expect(storeRootOf("/home/u/.local/share/pnpm/store")).toBe("/home/u/.local/share/pnpm/store");
    expect(storeRootOf("/data/v11x")).toBe("/data/v11x");
    expect(storeRootOf("/data/vault")).toBe("/data/vault");
  });
});

function writeMarker(out: string): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "marker"), "old");
}

describe("copyUnlinked", () => {
  it("gives the bundle its own inode for a file the deploy hardlinked from the workspace", () => {
    const root = tmp();
    const workspaceFile = join(root, "contracts-index.js");
    writeFileSync(workspaceFile, "export {};\n");
    const deployed = join(root, "deployed");
    mkdirSync(join(deployed, "node_modules/@pap/contracts/dist"), { recursive: true });
    const inDeploy = join(deployed, "node_modules/@pap/contracts/dist/index.js");
    linkSync(workspaceFile, inDeploy);
    expect(statSync(inDeploy).ino).toBe(statSync(workspaceFile).ino);

    const bundle = join(root, "bundle");
    copyUnlinked(deployed, bundle);
    const copied = join(bundle, "node_modules/@pap/contracts/dist/index.js");
    expect(readFileSync(copied, "utf8")).toBe("export {};\n");
    expect(statSync(copied).ino).not.toBe(statSync(workspaceFile).ino);
    expect(statSync(copied).nlink).toBe(1);
  });
});
