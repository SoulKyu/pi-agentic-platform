import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { putLicences } from "./licence-fixture.ts";
import { stageApp } from "./stage-app.ts";
import type { Runner } from "./build-archive-stage.ts";

const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

const fixture = (options: { dist?: boolean; manifest?: string } = {}) => {
  const root = mkdtempSync(join(tmpdir(), "pap-stage-app-"));
  roots.push(root);
  const repo = join(root, "repo");
  put(join(repo, "package.json"), options.manifest ?? '{"name":"root"}');
  put(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  put(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  putLicences(repo);
  for (const dir of ["apps/daemon", "apps/web", "packages/contracts", "packages/pi-host"]) {
    put(join(repo, dir, "package.json"), `{"name":"${dir}"}`);
    if (options.dist !== false) put(join(repo, dir, "dist/main.js"), "export {};");
  }
  return { repo, out: join(root, "stage") };
};

const okRunner: Runner = async (_cmd, _args, cwd) => {
  put(join(cwd, "node_modules/.bin/tool"), "#!/bin/sh\n");
  put(join(cwd, "node_modules/pkg/index.js"), "export {};");
};

describe("stageApp", () => {
  it("refuses a missing dist folder before it stages anything", async () => {
    const { repo, out } = fixture({ dist: false });
    await expect(stageApp({ repo, out, run: okRunner })).rejects.toThrow(/missing apps\/daemon\/dist/);
    expect(existsSync(out)).toBe(false);
  });

  it("refuses a credential in a staged manifest", async () => {
    const { repo, out } = fixture({ manifest: '{"name":"root","x":"//r.example/:_authToken=abc"}' });
    await expect(stageApp({ repo, out, run: okRunner })).rejects.toThrow(/registry credential/);
  });

  it("refuses an .npmrc with a token that appears after the install", async () => {
    const { repo, out } = fixture();
    const run: Runner = async (_cmd, _args, cwd) => put(join(cwd, ".npmrc"), "//r.example/:_authToken=abc\n");
    await expect(stageApp({ repo, out, run })).rejects.toThrow(
      /\.npmrc looks like it holds a registry credential/,
    );
  });

  it("refuses a staged file that names the stage path, naming the file but not the path", async () => {
    const { repo, out } = fixture();
    const run: Runner = async (_cmd, _args, cwd) =>
      put(join(cwd, "node_modules/pkg/cfg.json"), `{"p":"${cwd}"}`);
    const failure: unknown = await stageApp({ repo, out, run }).then(
      () => undefined,
      (error: unknown) => error,
    );
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toMatch(/node_modules\/pkg\/cfg\.json names the build directory/);
    expect(message).not.toContain(out);
  });

  it("stages the licence texts beside the code, and refuses a repository without them", async () => {
    const { repo, out } = fixture();
    await stageApp({ repo, out, run: okRunner });
    for (const file of ["LICENSE", "THIRD_PARTY_NOTICES.md", "LICENSES/Apache-2.0.txt"])
      expect(existsSync(join(out, file)), file).toBe(true);
    const bare = fixture();
    rmSync(join(bare.repo, "LICENSE"));
    await expect(stageApp({ ...bare, run: okRunner })).rejects.toThrow(/LICENSE/);
  });

  it("stages the dist folders and leaves no .bin shim", async () => {
    const { repo, out } = fixture();
    await stageApp({ repo, out, run: okRunner });
    expect(existsSync(join(out, "apps/daemon/dist/main.js"))).toBe(true);
    expect(existsSync(join(out, "apps/web/dist/main.js"))).toBe(true);
    expect(existsSync(join(out, "node_modules/pkg/index.js"))).toBe(true);
    const bins = readdirSync(out, { recursive: true }).filter((entry) => String(entry).endsWith(".bin"));
    expect(bins).toEqual([]);
  });
});
