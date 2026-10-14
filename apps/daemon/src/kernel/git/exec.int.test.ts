import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitBed, type GitBed } from "../testing/git-bed.ts";
import { gitArgs, gitEnv } from "./exec.ts";
import { parsePorcelainV2 } from "./porcelain.ts";

let bed: GitBed;
let dir: string;
let root: string;
let home: string;
const setupEnv = (): NodeJS.ProcessEnv => bed.setupEnv();
const git = (cwd: string, ...args: string[]): string => bed.git(cwd, ...args);
const runner = (base: NodeJS.ProcessEnv = {}) => bed.runner(base);
const initRepo = (path: string): void => bed.initRepo(path);
const plant = (name: string) => bed.plant(name);

const modify = (): void => writeFileSync(join(root, "a.txt"), "two\n");
const cfg = (key: string, value: string): string => git(root, "config", key, value);

beforeEach(() => {
  bed = createGitBed();
  ({ dir, root, home } = bed);
});
afterEach(() => bed.dispose());

describe("the runner never runs a program a repository configures", () => {
  it("core.fsmonitor in .git/config", async () => {
    const { script, marker } = plant("fsmonitor");
    cfg("core.fsmonitor", script);
    git(root, "status");
    expect(existsSync(marker), "control: plain git runs the plant").toBe(true);
    rmSync(marker);
    await runner().run(root, ["status", "--porcelain=v2", "-z"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("core.fsmonitor in a file named by include.path", async () => {
    const { script, marker } = plant("include");
    writeFileSync(join(dir, "extra.cfg"), `[core]\n\tfsmonitor = ${script}\n`);
    cfg("include.path", join(dir, "extra.cfg"));
    git(root, "status");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    await runner().run(root, ["status", "--porcelain=v2", "-z"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("diff.external", async () => {
    const { script, marker } = plant("external");
    cfg("diff.external", script);
    modify();
    git(root, "diff", "HEAD");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    // The runner adds --no-ext-diff itself (MC12); the blank diff.external is defence in depth.
    await expect(runner().run(root, ["diff", "HEAD"])).resolves.toMatchObject({ code: 0 });
    expect(existsSync(marker)).toBe(false);
    await expect(runner().run(root, ["diff", "--no-ext-diff", "HEAD"])).resolves.toMatchObject({ code: 0 });
    expect(existsSync(marker)).toBe(false);
  });

  it("a per-driver diff.<driver>.command, with --no-ext-diff", async () => {
    const { script, marker } = plant("driver");
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
    cfg("diff.evil.command", script);
    modify();
    git(root, "diff", "HEAD");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    await runner().run(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("diff.<driver>.textconv, with --no-textconv", async () => {
    const { script, marker } = plant("textconv");
    writeFileSync(join(root, ".gitattributes"), "*.txt diff=evil\n");
    cfg("diff.evil.textconv", script);
    modify();
    git(root, "diff", "HEAD");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    await runner().run(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
    await runner().run(root, ["cat-file", "blob", "HEAD:a.txt"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("a hook in .git/hooks and one in a core.hooksPath folder (post-index-change)", async () => {
    const { marker } = plant("hook");
    const hooksDir = join(dir, "hooks");
    mkdirSync(hooksDir);
    for (const folder of [hooksDir, join(root, ".git", "hooks")]) {
      const hook = join(folder, "post-index-change");
      writeFileSync(hook, `#!/bin/sh\necho ran > '${marker}'\n`);
      chmodSync(hook, 0o755);
    }
    const stale = (): void =>
      utimesSync(join(root, "a.txt"), new Date(Date.now() - 5000), new Date(Date.now() - 5000));
    stale();
    git(root, "update-index", "--refresh");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    cfg("core.hooksPath", hooksDir);
    stale();
    git(root, "update-index", "--refresh");
    expect(existsSync(marker), "control with hooksPath").toBe(true);
    rmSync(marker);
    stale();
    // The runner starts no index-writing subcommand, so the flags are exercised directly: the hook is what they neutralise.
    execFileSync("git", gitArgs(root, ["update-index", "--refresh"]), {
      env: { ...gitEnv({ PATH: process.env.PATH, HOME: home }, root) },
    });
    await runner().run(root, ["status", "--porcelain=v2", "-z"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("a submodule whose own config sets core.fsmonitor", async () => {
    const { script, marker } = plant("submodule");
    const sub = join(dir, "subsrc");
    initRepo(sub);
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "vendor");
    git(root, "commit", "-q", "-m", "sub");
    git(join(root, "vendor"), "config", "core.fsmonitor", script);
    writeFileSync(join(root, "vendor", "a.txt"), "changed\n");
    git(root, "status");
    expect(existsSync(marker), "control: plain git runs the submodule's plant").toBe(true);
    rmSync(marker);
    await runner().run(root, ["status", "--porcelain=v2", "-z", "--ignore-submodules=dirty"]);
    expect(existsSync(marker)).toBe(false);
    await runner().run(root, ["status", "--porcelain=v2", "-z"]);
    expect(existsSync(marker)).toBe(false);
    await runner().run(root, ["diff", "HEAD"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("an embedded repository recorded only as an index gitlink", async () => {
    const { script, marker } = plant("gitlink");
    const embedded = join(root, "emb");
    initRepo(embedded);
    git(embedded, "config", "core.fsmonitor", script);
    writeFileSync(join(embedded, "a.txt"), "changed\n");
    const oid = git(embedded, "rev-parse", "HEAD").trim();
    git(root, "update-index", "--add", "--cacheinfo", `160000,${oid},emb`);
    git(root, "status");
    expect(existsSync(marker), "control").toBe(true);
    rmSync(marker);
    await runner().run(root, ["status", "--porcelain=v2", "-z"]);
    expect(existsSync(marker)).toBe(false);
  });

  it("GIT_EXTERNAL_DIFF and GIT_CONFIG_* in the daemon's own environment", async () => {
    const { script, marker } = plant("env");
    modify();
    const planted = {
      GIT_EXTERNAL_DIFF: script,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.fsmonitor",
      GIT_CONFIG_VALUE_0: script,
    };
    execFileSync("git", ["status"], { cwd: root, env: { ...setupEnv(), ...planted }, stdio: "ignore" });
    expect(existsSync(marker), "control: plain git obeys the environment").toBe(true);
    rmSync(marker);
    const dirty = runner(planted);
    await dirty.run(root, ["status", "--porcelain=v2", "-z"]);
    await expect(dirty.run(root, ["diff", "HEAD"])).resolves.toMatchObject({ code: 0 });
    expect(existsSync(marker)).toBe(false);
  });
});

describe("repository discovery and arguments", () => {
  it("reports this repository's branch although the daemon's environment has GIT_DIR", async () => {
    const other = join(dir, "other");
    initRepo(other);
    git(other, "checkout", "-q", "-b", "elsewhere");
    const out = await runner({ GIT_DIR: join(other, ".git") }).run(root, [
      "rev-parse",
      "--abbrev-ref",
      "HEAD",
    ]);
    expect(out.stdout.toString("utf8").trim()).toBe("main");
  });

  it("a plain folder inside a repository is not that repository", async () => {
    const plain = join(root, "plain");
    mkdirSync(plain);
    await expect(runner().run(plain, ["rev-parse", "--show-toplevel"])).rejects.toMatchObject({
      kind: "failed",
    });
    const top = await runner().run(root, ["rev-parse", "--show-toplevel"]);
    expect(top.stdout.toString("utf8").trim()).toBe(root);
  });

  it("a committed file named -rf is read as a blob, not parsed as an option", async () => {
    const out = await runner().run(root, ["cat-file", "blob", "HEAD:-rf"]);
    expect(out.stdout.toString("utf8")).toBe("dash\n");
  });

  it("a file named a\\nb round-trips through status --porcelain=v2 -z", async () => {
    writeFileSync(join(root, "a\nb"), "changed\n");
    const out = await runner().run(root, ["status", "--porcelain=v2", "-z", "--branch"]);
    const status = parsePorcelainV2(out.stdout);
    expect(status.entries.map((e) => e.path)).toEqual(["a\nb"]);
    expect(status.branch.head).toBe("main");
  });

  it("a pathspec that looks like a glob is literal", async () => {
    writeFileSync(join(root, "a.txt"), "changed\n");
    const out = await runner().run(root, ["status", "--porcelain=v2", "-z", "--", "*.txt"]);
    expect(parsePorcelainV2(out.stdout).entries).toEqual([]);
  });
});

describe("check-ignore without --literal-pathspecs (MC15)", () => {
  const ignored = async (input: string, extra: string[] = []): Promise<string[]> => {
    const out = await runner().run(root, ["check-ignore", "-z", "--stdin", "--no-index", ...extra], {
      input: Buffer.from(input),
      okCodes: [0, 1],
    });
    return out.stdout.toString("utf8").split("\0").filter(Boolean);
  };

  it("answers for stdin names (exit 128 under --literal-pathspecs)", async () => {
    writeFileSync(join(root, ".gitignore"), "secret*\n");
    expect(await ignored("./secret1\0./a.txt\0")).toEqual(["./secret1"]);
  });

  it("answers for positional paths", async () => {
    writeFileSync(join(root, ".gitignore"), "secret*\n");
    const out = await runner().run(root, ["check-ignore", "--no-index", "./secret1"], { okCodes: [0, 1] });
    expect(out.stdout.toString("utf8")).toBe("./secret1\n");
  });

  it("matches a name that looks like pathspec magic literally against the ignore rules", async () => {
    writeFileSync(join(root, ".gitignore"), "secret*\n:(glob)lit*\n");
    // As a literal name ':(glob)secret' does not start with 'secret'; as magic it would be the path 'secret'.
    expect(await ignored("./:(glob)secret\0")).toEqual([]);
    expect(await ignored("./secret\0")).toEqual(["./secret"]);
    // The pattern ':(glob)lit*' is an ordinary ignore line; it matches the literal name.
    expect(await ignored("./:(glob)lit1\0./:(glob)*\0")).toEqual(["./:(glob)lit1"]);
  });
});
