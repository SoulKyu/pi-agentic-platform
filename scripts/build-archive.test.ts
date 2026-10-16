import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildArchive, type Runner } from "./build-archive.ts";

const ID = "0.0.0-abc1234-202610151200";
const roots: string[] = [];

afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const put = (path: string, text: string, mode?: number) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, mode === undefined ? undefined : { mode });
};

interface Fixture {
  repo: string;
  out: string;
  node: string;
}

const fixture = (overrides: { nodeVersion?: string; license?: boolean; manifest?: string } = {}): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "pap-archive-"));
  roots.push(root);
  const repo = join(root, "repo");
  put(join(repo, "package.json"), overrides.manifest ?? '{"name":"root","packageManager":"pnpm@10.34.6"}');
  put(join(repo, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n  - packages/*\n");
  put(join(repo, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  put(
    join(repo, ".npmrc"),
    "engine-strict=true\n//registry.example/:_authToken=abc\nregistry=https://registry.example/\n",
  );
  for (const dir of ["apps/daemon", "apps/web", "packages/contracts", "packages/pi-host", "packages/ui"]) {
    put(join(repo, dir, "package.json"), `{"name":"${dir}"}`);
    put(join(repo, dir, "src/secret.ts"), "export {};");
    put(join(repo, dir, "src/thing.test.ts"), "export {};");
  }
  put(join(repo, "apps/daemon/dist/main.js"), "console.log('daemon');");
  put(join(repo, "apps/web/dist/index.html"), "<html></html>");
  put(join(repo, "packages/contracts/dist/main.js"), "export {};");
  put(join(repo, "packages/pi-host/dist/main.js"), "export {};");
  put(join(repo, ".env"), "KEY=1");
  put(join(repo, "docs/readme.md"), "docs");
  put(
    join(repo, "scripts/archive-install.sh.tpl"),
    [
      "#!/bin/sh",
      'readonly EXPECTED_SHA256="@@SHA256@@"',
      'readonly RELEASE_ID="@@RELEASE_ID@@"',
      'readonly ARCHIVE_NAME="@@ARCHIVE_NAME@@"',
      'readonly MIN_GLIBC="@@MIN_GLIBC@@"',
      "",
    ].join("\n"),
  );
  const prefix = join(root, "prefix");
  const node = join(prefix, "bin/node");
  put(node, `#!/bin/sh\necho ${overrides.nodeVersion ?? "v24.14.1"}\n`, 0o755);
  if (overrides.license !== false) put(join(prefix, "LICENSE"), "Node license");
  return { repo, out: join(root, "out"), node };
};

interface Recorded {
  cmd: string;
  args: readonly string[];
  cwd: string;
}

const makeRunner =
  (calls: Recorded[], extra: (cwd: string) => void = () => undefined): Runner =>
  (cmd, args, cwd) => {
    extra(cwd);
    calls.push({ cmd, args, cwd });
    put(join(cwd, "node_modules/marker"), "ok");
    put(join(cwd, "node_modules/.modules.yaml"), "storeDir: /home/builder/store\n");
    put(join(cwd, "node_modules/.pnpm-workspace-state-v1.json"), "{}");
    return Promise.resolve();
  };

const build = (
  fx: Fixture,
  extra: Partial<Parameters<typeof buildArchive>[0]> = {},
  calls: Recorded[] = [],
) =>
  buildArchive({
    repo: fx.repo,
    outDir: fx.out,
    nodePath: fx.node,
    releaseId: ID,
    glibc: "2.39",
    run: makeRunner(calls),
    gitSha: "abc1234",
    dirty: false,
    epoch: 1_700_000_000,
    ...extra,
  });

const list = (archive: string, verbose = false) =>
  execFileSync("tar", [verbose ? "-tvzf" : "-tzf", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);

const noOutputs = (fx: Fixture) => expect(existsSync(fx.out) ? readdirSync(fx.out) : []).toEqual([]);

describe("buildArchive", () => {
  it("packs only pap-<id>/ members with the runtime, the dist folders and an allowlisted .npmrc", async () => {
    const fx = fixture();
    const { archive } = await build(fx);
    const members = list(archive);
    expect(members.every((m) => m.startsWith(`pap-${ID}/`))).toBe(true);
    for (const wanted of [
      "node/bin/node",
      "node/LICENSE",
      "app/apps/daemon/dist/main.js",
      "app/apps/web/dist/index.html",
      "app/node_modules/marker",
      "BUILD_INFO.json",
    ]) {
      expect(members).toContain(`pap-${ID}/${wanted}`);
    }
    for (const forbidden of ["/src/", ".git", ".env", "/docs/", "test", ".modules.yaml", "workspace-state"]) {
      expect(members.filter((m) => m.includes(forbidden))).toEqual([]);
    }
    const staged = execFileSync("tar", ["-xzOf", archive, `pap-${ID}/app/.npmrc`], { encoding: "utf8" });
    expect(staged).toBe("engine-strict=true\n");
    const info = JSON.parse(
      execFileSync("tar", ["-xzOf", archive, `pap-${ID}/BUILD_INFO.json`], { encoding: "utf8" }),
    );
    expect(info).toEqual({
      releaseId: ID,
      builtAt: "2023-11-14T22:13:20.000Z",
      node: "v24.14.1",
      glibc: "2.39",
      gitSha: "abc1234",
    });
  });

  it("pins the installer to the archive sha-256 and writes the .sha256 file", async () => {
    const fx = fixture();
    const { archive, installer, sha256 } = await build(fx);
    const actual = createHash("sha256").update(readFileSync(archive)).digest("hex");
    expect(sha256).toBe(actual);
    const name = `pap-${ID}-linux-x64.tar.gz`;
    expect(archive).toBe(join(fx.out, name));
    expect(readFileSync(`${archive}.sha256`, "utf8")).toBe(`${actual}  ${name}\n`);
    const script = readFileSync(installer, "utf8");
    expect(script).toContain(`readonly EXPECTED_SHA256="${actual}"`);
    expect(script).toContain(`readonly RELEASE_ID="${ID}"`);
    expect(script).toContain(`readonly ARCHIVE_NAME="${name}"`);
    expect(script).toContain('readonly MIN_GLIBC="2.39"');
    expect(script).not.toContain("@@");
    expect(readdirSync(fx.out).sort()).toEqual([name, `${name}.sha256`, `pap-install-${ID}.sh`]);
  });

  it("owns members as root and writes the installer 0755", async () => {
    const fx = fixture();
    const { archive, installer } = await build(fx);
    const lines = list(archive, true);
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(line.split(/\s+/)[1]).toBe("0/0");
    expect(statSync(installer).mode & 0o777).toBe(0o755);
  });

  it("installs the production dependencies offline with the frozen lockfile in <stage>/app", async () => {
    const fx = fixture();
    const calls: Recorded[] = [];
    const store = join(dirname(fx.repo), "store");
    put(join(store, "files/00"), "x");
    await build(fx, { storeDir: store }, calls);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.cmd).toBe("pnpm");
    expect(call?.args).toEqual([
      "install",
      "--prod",
      "--frozen-lockfile",
      "--offline",
      "--package-import-method=copy",
      "--store-dir",
      store,
      "--filter",
      "@pap/daemon...",
    ]);
    expect(call?.cwd).toMatch(new RegExp(`/pap-${ID}/app$`));
    expect(call?.cwd.startsWith(fx.out)).toBe(true);
    expect(readdirSync(fx.out).some((entry) => entry.startsWith(".stage"))).toBe(false);
  });

  describe("refusals leave no output", () => {
    it("a missing dist folder", async () => {
      const fx = fixture();
      rmSync(join(fx.repo, "packages/pi-host/dist"), { recursive: true });
      await expect(build(fx)).rejects.toThrow(/run pnpm build first/);
      noOutputs(fx);
    });

    it("a dirty tree without allowDirty, and accepts it with the flag", async () => {
      const fx = fixture();
      await expect(build(fx, { dirty: true })).rejects.toThrow(/uncommitted changes/);
      noOutputs(fx);
      await expect(build(fx, { dirty: true, allowDirty: true })).rejects.toThrow(/-dirty/);
      noOutputs(fx);
      await expect(
        build(fx, { dirty: true, allowDirty: true, releaseId: "0.0.0-abc1234-dirty-202610151200" }),
      ).resolves.toBeDefined();
    });

    it("a node that is not 24.14 or newer 24.x", async () => {
      for (const version of ["v22.12.0", "v24.13.9", "v25.0.0"]) {
        const fx = fixture({ nodeVersion: version });
        await expect(build(fx)).rejects.toThrow(/Node v24\.14/);
        noOutputs(fx);
      }
    });

    it("a node without its LICENSE beside the prefix", async () => {
      const fx = fixture({ license: false });
      await expect(build(fx)).rejects.toThrow(/LICENSE/);
      noOutputs(fx);
    });

    it.each(["a/b", "a b", "a'b", "", "a".repeat(65)])("release id %j", async (releaseId) => {
      const fx = fixture();
      await expect(build(fx, { releaseId })).rejects.toThrow(/release id/);
      noOutputs(fx);
    });

    it("a glibc value that is not <major>.<minor>", async () => {
      const fx = fixture();
      await expect(build(fx, { glibc: "2.3x; rm" })).rejects.toThrow(/glibc/);
      noOutputs(fx);
    });

    it.each([
      ["package.json", join("apps/web/package.json"), '{"x":"//reg.example/:_authToken=abc"}'],
      ["root package.json", "package.json", '{"x":"npm_abcdefghijklmnopqrstuvwxyz0123456789"}'],
      ["pnpm-workspace.yaml", "pnpm-workspace.yaml", "x: _password=hunter2\n"],
    ])("a credential in %s", async (_label, file, text) => {
      const fx = fixture();
      put(join(fx.repo, file), text);
      await expect(build(fx)).rejects.toThrow(/credential/);
      noOutputs(fx);
    });
  });

  it("removes pnpm .bin shims, so no member names the build directory", async () => {
    const fx = fixture();
    const run = makeRunner([], (cwd) => {
      put(join(cwd, "node_modules/.bin/tool"), `export NODE_PATH="${cwd}/node_modules"`);
      put(join(cwd, "apps/daemon/node_modules/.bin/yaml"), `export NODE_PATH="${cwd}"`);
      put(join(cwd, "node_modules/.pnpm/p@1/node_modules/q/node_modules/.bin/z"), cwd);
      put(join(cwd, "node_modules/.pnpm/p@1/node_modules/q/index.js"), "keep");
    });
    const { archive } = await build(fx, { run });
    const members = list(archive);
    expect(members.filter((m) => m.includes(".bin"))).toEqual([]);
    expect(members).toContain(`pap-${ID}/app/node_modules/.pnpm/p@1/node_modules/q/index.js`);
    const all = execFileSync("tar", ["-xzOf", archive], { encoding: "utf8", maxBuffer: 1 << 24 });
    expect(all).not.toContain(".stage-");
  });

  it("drops node-gyp leftovers beside pty.node and refuses a file naming the builder home", async () => {
    const fx = fixture();
    const run = makeRunner([], (cwd) => {
      const build = join(cwd, "node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/build");
      put(join(build, "Makefile"), "nodedir := /home/builder/.cache/node-gyp");
      put(join(build, "config.gypi"), "{}");
      put(join(build, "Release/pty.node"), "binary");
    });
    const { archive } = await build(fx, { run });
    const members = list(archive).map((m) =>
      m.replace(`pap-${ID}/app/node_modules/.pnpm/node-pty@1.1.0/node_modules/node-pty/`, ""),
    );
    expect(members.filter((m) => m.startsWith("build/") && !m.endsWith("/"))).toEqual([
      "build/Release/pty.node",
    ]);
    const leaking = makeRunner([], (cwd) => put(join(cwd, "node_modules/x.txt"), `see ${homedir()}/y`));
    await expect(build(fx, { run: leaking })).rejects.toThrow(
      /x\.txt names the build directory or the builder home/,
    );
  });

  it.each([
    ["the build directory", (cwd: string) => `${cwd}/target`],
    ["the builder home", () => `${homedir()}/target`],
  ])("refuses a symbolic link whose target names %s, naming only the link", async (_label, target) => {
    const fx = fixture();
    const run = makeRunner([], (cwd) => {
      mkdirSync(join(cwd, "node_modules"), { recursive: true });
      symlinkSync(target(cwd), join(cwd, "node_modules/link"));
    });
    const failure = build(fx, { run });
    await expect(failure).rejects.toThrow(/app\/node_modules\/link names the build directory/);
    await expect(failure).rejects.not.toThrow(/\.stage-/);
    noOutputs(fx);
  });

  it("refuses a staged file that names the build directory, naming only the file", async () => {
    const fx = fixture();
    const run = makeRunner([], (cwd) => put(join(cwd, "node_modules/leak.txt"), `built in ${cwd}`));
    const failure = build(fx, { run });
    await expect(failure).rejects.toThrow(
      /app\/node_modules\/leak\.txt names the build directory or the builder home/,
    );
    await expect(failure).rejects.not.toThrow(/\.stage-/);
    noOutputs(fx);
  });

  it("removes the stage and every output when the runner rejects", async () => {
    const fx = fixture();
    const run: Runner = () => Promise.reject(new Error("boom"));
    await expect(build(fx, { run })).rejects.toThrow();
    expect(readdirSync(fx.out)).toEqual([]);
  });

  it("explains a missing or empty pnpm store before running pnpm", async () => {
    const fx = fixture();
    const calls: Recorded[] = [];
    const store = join(dirname(fx.repo), "store");
    const message = `the pnpm store at ${store} lacks the packages: run pnpm install first`;
    await expect(build(fx, { storeDir: store }, calls)).rejects.toThrow(message);
    mkdirSync(store);
    await expect(build(fx, { storeDir: store }, calls)).rejects.toThrow(message);
    expect(calls).toEqual([]);
    noOutputs(fx);
  });

  it("maps a failing pnpm install to the same sentence without the raw error", async () => {
    const fx = fixture();
    const store = join(dirname(fx.repo), "store");
    put(join(store, "files/00"), "x");
    const run: Runner = () => Promise.reject(new Error("ERR_PNPM_NO_OFFLINE_TARBALL secret-detail"));
    const failure = build(fx, { run, storeDir: store });
    await expect(failure).rejects.toThrow(`the pnpm store at ${store} lacks the packages`);
    await expect(failure).rejects.not.toThrow(/secret-detail/);
    noOutputs(fx);
  });

  it("refuses a symlink inside a dist folder", async () => {
    const fx = fixture();
    symlinkSync("/etc/passwd", join(fx.repo, "apps/web/dist/link"));
    await expect(build(fx)).rejects.toThrow(/symlink/);
    noOutputs(fx);
  });

  it("normalizes modes: no group or other write, directories searchable", async () => {
    const fx = fixture();
    chmodSync(join(fx.repo, "apps/web/dist/index.html"), 0o666);
    const { archive } = await build(fx);
    for (const line of list(archive, true)) {
      const mode = line.split(/\s+/)[0] ?? "";
      expect(mode[5]).toBe("-");
      expect(mode[8]).toBe("-");
      if (mode.startsWith("d")) expect(mode).toBe("drwxr-xr-x");
    }
  });

  it("gives byte-identical archives for the same inputs", async () => {
    const a = fixture();
    const b = fixture();
    const first = await build(a);
    const second = await build(b);
    expect(readFileSync(first.archive).equals(readFileSync(second.archive))).toBe(true);
    expect(first.sha256).toBe(second.sha256);
  });
});
