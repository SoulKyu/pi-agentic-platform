import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "install.sh");
const CORE_TOOLS = ["id", "uname", "dirname", "stat"];
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const exe = (path: string, body: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  chmodSync(path, 0o755);
};

interface Options {
  nodeVersion?: string;
  missing?: string[];
  systemctlFails?: boolean;
  noWorkspaceFile?: boolean;
  buildLeavesWeb?: boolean;
  env?: Record<string, string>;
  args?: string[];
  rootName?: string;
  nodeFails?: boolean;
}

function setup(options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), options.rootName ?? "pap-install-test-"));
  dirs.push(root);
  const repo = join(root, "repo");
  const log = join(root, "log");
  const tools = join(root, "tools");
  const core = join(root, "core");
  const real = join(root, "real");
  mkdirSync(join(repo, "apps/daemon"), { recursive: true });
  mkdirSync(join(repo, "apps/web"), { recursive: true });
  mkdirSync(join(repo, "scripts"), { recursive: true });
  if (!options.noWorkspaceFile) writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
  copyFileSync(SCRIPT, join(repo, "scripts/install.sh"));
  chmodSync(join(repo, "scripts/install.sh"), 0o755);
  mkdirSync(core, { recursive: true });
  for (const tool of CORE_TOOLS) symlinkSync(`/usr/bin/${tool}`, join(core, tool));
  exe(join(real, "node"), 'echo "node $*" >> "$LOG"');
  exe(
    join(tools, "node"),
    [
      ...(options.nodeFails ? ["exit 1"] : []),
      'case "$*" in',
      '  *versions.node*) echo "$FAKE_NODE" ;;',
      `  *execPath*) echo '${join(real, "node")}' ;;`,
      "esac",
    ].join("\n"),
  );
  const build = (prefix: string) =>
    [
      `echo "${prefix}$*" >> "$LOG"`,
      'echo "$PWD" >> "$LOG.cwd"',
      'case "$*" in *build) /usr/bin/mkdir -p \'' + repo + "/apps/daemon/dist' '" + repo + "/apps/web/dist'",
      "  echo x > '" + repo + "/apps/daemon/dist/main.js'",
      ...(options.buildLeavesWeb ? [] : ["  echo x > '" + repo + "/apps/web/dist/index.html'"]),
      "  ;; esac",
    ].join("\n");
  exe(join(tools, "pnpm"), build("pnpm "));
  exe(join(tools, "corepack"), build("corepack "));
  exe(join(tools, "systemctl"), options.systemctlFails ? "exit 1" : "exit 0");
  for (const tool of ["gcc", "g++", "make", "python3"]) exe(join(tools, tool), "exit 0");
  for (const name of options.missing ?? []) rmSync(join(tools, name));
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  const run = () =>
    spawnSync("/usr/bin/bash", [join(repo, "scripts/install.sh"), ...(options.args ?? [])], {
      env: {
        PATH: `${tools}:${core}`,
        HOME: root,
        LOG: log,
        FAKE_NODE: options.nodeVersion ?? "24.14.1",
        ...options.env,
      },
      encoding: "utf8",
      cwd: elsewhere,
    });
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
  const cwds = () =>
    existsSync(`${log}.cwd`) ? readFileSync(`${log}.cwd`, "utf8").split("\n").filter(Boolean) : [];
  return { root, repo, real, run, lines, cwds };
}

describe("scripts/install.sh", () => {
  it("builds, then execs the real node binary (not the shim) on service install", () => {
    const t = setup();
    const result = t.run();
    const main = `${t.repo}/apps/daemon/dist/main.js`;
    expect(result.status).toBe(0);
    expect(t.lines()).toEqual([
      "pnpm install --frozen-lockfile",
      "pnpm build",
      `node --disable-warning=ExperimentalWarning ${main} service install --node ${t.real}/node --main ${main}`,
    ]);
    expect(t.cwds()).toEqual([realpathSync(t.repo), realpathSync(t.repo)]);
  });

  it("forwards the remaining arguments after --main", () => {
    const t = setup({ args: ["--port", "7790"] });
    expect(t.run().status).toBe(0);
    expect(t.lines().at(-1)).toMatch(/ --main \S+ --port 7790$/);
  });

  it.each(["22.1.0", "24.13.0", "25.0.0"])("refuses node %s before any build", (version) => {
    const t = setup({ nodeVersion: version });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`pap-install: node ${version} found; pap needs >=24.14 <25\n`);
    expect(t.lines()).toEqual([]);
  });

  it.each(["gcc", "g++", "make", "python3"])("refuses when %s is missing before any build", (tool) => {
    const t = setup({ missing: [tool] });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`missing tool: ${tool}`);
    expect(t.lines()).toEqual([]);
  });

  it("refuses without a systemd user manager and names XDG_RUNTIME_DIR", () => {
    const t = setup({ systemctlFails: true });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("XDG_RUNTIME_DIR=/run/user/");
    expect(t.lines()).toEqual([]);
  });

  it("refuses a directory that is not a pap checkout", () => {
    const t = setup({ noWorkspaceFile: true });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("not a pap checkout");
    expect(t.lines()).toEqual([]);
  });

  it("falls back to corepack pnpm, and refuses when both are absent", () => {
    const withCorepack = setup({ missing: ["pnpm"] });
    expect(withCorepack.run().status).toBe(0);
    expect(withCorepack.lines().slice(0, 2)).toEqual([
      "corepack pnpm install --frozen-lockfile",
      "corepack pnpm build",
    ]);
    const neither = setup({ missing: ["pnpm", "corepack"] });
    const result = neither.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("corepack enable");
    expect(neither.lines()).toEqual([]);
  });

  it("does not call service install when the build leaves no web bundle", () => {
    const t = setup({ buildLeavesWeb: true });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("the build left no apps/daemon/dist/main.js or apps/web/dist");
    expect(t.lines()).toEqual(["pnpm install --frozen-lockfile", "pnpm build"]);
  });

  it.skipIf(process.getuid?.() !== 0)("refuses to run as root", () => {
    const result = setup().run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("do not run as root");
  });

  it.each(["24.14.0", "24.20.3"])("accepts node %s", (version) => {
    expect(setup({ nodeVersion: version }).run().status).toBe(0);
  });

  it("refuses when node fails to run, before any build", () => {
    const t = setup({ nodeFails: true });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toBe("pap-install: node failed to run\n");
    expect(t.lines()).toEqual([]);
  });

  it("refuses an empty node version", () => {
    const t = setup({ nodeVersion: "" });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("node failed to run");
    expect(t.lines()).toEqual([]);
  });

  it("refuses a checkout path the service unit cannot carry, before any build", () => {
    const t = setup({ rootName: "pap install " });
    const result = t.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "the checkout path or the node path has a character that the service unit cannot carry",
    );
    expect(t.lines()).toEqual([]);
  });

  it("needs no bubblewrap and no sudo: a clean install prints nothing on stderr", () => {
    const result = setup().run();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/bwrap|bubblewrap|sudo/i);
  });
});
