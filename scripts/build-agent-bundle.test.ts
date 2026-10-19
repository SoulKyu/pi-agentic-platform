import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { putAgentBundle } from "./agent-bundle-fixture.ts";
import { AGENT_BUNDLE, assertAgentBundle, buildAgentBundle } from "./build-agent-bundle.ts";

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
    expect(readdirSync(t.out).sort()).toEqual(["dist", "node_modules", "package.json"]);
    expect(existsSync(join(t.out, "dist/guest/main.js"))).toBe(true);
    expect(existsSync(join(t.out, "dist/relay/main.js"))).toBe(true);
    expect(readdirSync(join(t.repo, "packages/pi-host"))).toEqual(["dist-agent"]);
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

function writeMarker(out: string): void {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "marker"), "old");
}
