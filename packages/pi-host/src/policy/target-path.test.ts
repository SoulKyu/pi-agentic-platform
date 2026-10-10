import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkEditTarget } from "./target-path.ts";

let base: string;
let cwd: string;
let outside: string;
let agentDir: string;
let home: string;

const check = (path: unknown, from = cwd) => checkEditTarget(path, from, agentDir);
const isAuto = async (path: unknown, from = cwd) => (await check(path, from)).auto;
const reviewOf = async (path: unknown, from = cwd) => {
  const result = await check(path, from);
  return result.auto ? undefined : result.review;
};

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pap-target-path-")));
  cwd = join(base, "proj");
  outside = join(base, "outside");
  agentDir = join(base, "agent");
  home = join(base, "home");
  vi.stubEnv("HOME", home);
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "..hidden"), { recursive: true });
  await mkdir(join(base, "proj-evil"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "x");
  await writeFile(join(outside, "secret.txt"), "x");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(base, { recursive: true, force: true });
});

describe("checkEditTarget: plain paths", () => {
  it.each([
    "src/a.ts",
    "./src/a.ts",
    "src/new.ts",
    "src/deep/er/new.ts",
    "src/../src/a.ts",
    "..hidden/f",
    ".",
  ])("accepts %j", async (path) => {
    expect(await isAuto(path, cwd)).toBe(true);
  });

  it("accepts an absolute path inside the directory, existing or not", async () => {
    expect(await isAuto(join(cwd, "src", "a.ts"), cwd)).toBe(true);
    expect(await isAuto(join(cwd, "src", "later.ts"), cwd)).toBe(true);
  });

  it("accepts paths through a symlinked cwd", async () => {
    await symlink(cwd, join(base, "alias"), "dir");
    expect(await isAuto("src/a.ts", join(base, "alias"))).toBe(true);
    expect(await isAuto(join(base, "alias", "src", "new.ts"), cwd)).toBe(true);
  });
});

describe("checkEditTarget: traversal and absolute escapes", () => {
  it.each([
    "../outside/secret.txt",
    "../outside/new.txt",
    "src/../../outside/new.txt",
    "../proj-evil/a.ts",
    "..",
  ])("rejects %j", async (path) => {
    expect(await isAuto(path, cwd)).toBe(false);
  });

  it("rejects absolute paths outside the directory and the sibling that shares its prefix", async () => {
    expect(await isAuto(join(outside, "secret.txt"), cwd)).toBe(false);
    expect(await isAuto(join(base, "proj-evil", "a.ts"), cwd)).toBe(false);
    expect(await isAuto("/etc/passwd", cwd)).toBe(false);
  });
});

describe("checkEditTarget: symlinks", () => {
  it("rejects a directory symlink that leaves the directory, existing or new target", async () => {
    await symlink(outside, join(cwd, "link"), "dir");
    expect(await isAuto("link/secret.txt", cwd)).toBe(false);
    expect(await isAuto("link/new.txt", cwd)).toBe(false);
    expect(await isAuto("link/new/dir/new.txt", cwd)).toBe(false);
  });

  it("rejects a file symlink to a file outside the directory", async () => {
    await symlink(join(outside, "secret.txt"), join(cwd, "leak.txt"));
    expect(await isAuto("leak.txt", cwd)).toBe(false);
  });

  it("rejects a dangling symlink whose target would be created outside", async () => {
    await symlink(join(outside, "not-yet.txt"), join(cwd, "dangling.txt"));
    expect(await isAuto("dangling.txt", cwd)).toBe(false);
  });

  it("rejects a chain of symlinks whose last hop leaves the directory", async () => {
    await symlink(join(outside, "not-yet.txt"), join(cwd, "hop2"));
    await symlink("hop2", join(cwd, "hop1"));
    expect(await isAuto("hop1", cwd)).toBe(false);
  });

  it("resolves a relative dangling link from the real directory it lives in", async () => {
    await symlink(outside, join(cwd, "link"), "dir");
    await symlink("../not-yet.txt", join(outside, "rel"));
    expect(await isAuto("link/rel", cwd)).toBe(false);
  });

  it("accepts a symlink that stays inside the directory", async () => {
    await symlink(join(cwd, "src"), join(cwd, "alias"), "dir");
    await symlink("a.ts", join(cwd, "src", "a-link.ts"));
    expect(await isAuto("alias/new.ts", cwd)).toBe(true);
    expect(await isAuto("src/a-link.ts", cwd)).toBe(true);
  });

  it("fails instead of looping on a symlink cycle", async () => {
    await symlink("b", join(cwd, "a"));
    await symlink("a", join(cwd, "b"));
    await expect(check("a", cwd)).rejects.toThrow();
  });
});

describe("checkEditTarget: spellings Pi rewrites before it touches the file", () => {
  it.each(["~/elsewhere.txt", "~", "@/etc/passwd", "@../outside/new.txt", "file:///etc/passwd"])(
    "rejects %j",
    async (path) => {
      expect(await isAuto(path, cwd)).toBe(false);
    },
  );

  it("reads a no-break space as the ordinary space Pi turns it into", async () => {
    await symlink(outside, join(cwd, "link "), "dir");
    const noBreakSpace = String.fromCharCode(0xa0);
    expect(await isAuto(`link${noBreakSpace}/new.txt`, cwd)).toBe(false);
  });

  it("accepts the @ prefix when the rest stays inside", async () => {
    expect(await isAuto("@src/a.ts", cwd)).toBe(true);
  });

  it("rejects a file URL with a foreign host instead of guessing", async () => {
    await expect(check("file://example.com/etc/passwd", cwd)).rejects.toThrow();
  });
});

describe("checkEditTarget: malformed input", () => {
  it.each([undefined, null, 42, {}, ["src/a.ts"], "", "src/a\0.ts"])("rejects %j", async (path) => {
    expect(await isAuto(path, cwd)).toBe(false);
  });
});

describe("checkEditTarget: protected paths ask even inside the session directory", () => {
  it.each([
    ".git/hooks/pre-commit",
    ".git/config",
    ".GIT/config",
    ".Git/hooks/post-checkout",
    "sub/.git/config",
    ".git",
    ".pi/settings.json",
    ".pi/extensions/x.ts",
    "packages/app/.pi/settings.json",
    ".agents/skills/x/SKILL.md",
    ".husky/pre-commit",
    ".vscode/tasks.json",
    ".envrc",
    ".ENVRC",
    "sub/.envrc",
    "src/../.git/config",
    "./.git/config",
  ])("%j is protected", async (path) => {
    const review = await reviewOf(path);
    expect(review?.why).toBe("protected path");
    expect(review?.target).toBe(join(cwd, path.replace("src/../", "").replace("./", "")));
  });

  it.each([
    ".gitignore",
    ".github/workflows/ci.yml",
    ".envrc.example",
    "envrc",
    "src/.pi-notes.md",
    ".piece/x",
    "git/config",
  ])("%j is an ordinary file", async (path) => {
    expect(await isAuto(path)).toBe(true);
  });

  it("sees a protected directory behind a symlink that looks harmless", async () => {
    await mkdir(join(cwd, ".git"), { recursive: true });
    await symlink(join(cwd, ".git"), join(cwd, "docs"), "dir");
    const review = await reviewOf("docs/config");
    expect(review).toEqual({ why: "protected path", target: join(cwd, ".git", "config") });
  });

  it("protects a path by the protected name it is reached through, whatever the name points to", async () => {
    await mkdir(join(cwd, "gitdata"), { recursive: true });
    await symlink(join(cwd, "gitdata"), join(cwd, ".git"), "dir");
    expect(await reviewOf(".git/config")).toEqual({
      why: "protected path",
      target: join(cwd, "gitdata", "config"),
    });
  });

  it("sees a protected name that Pi's own rewrites produce", async () => {
    expect((await reviewOf("@.git/config"))?.why).toBe("protected path");
  });

  it("protects everything inside the agent directory, wherever it sits", async () => {
    const inside = join(cwd, "state");
    expect((await check("state/auth.json", cwd)).auto).toBe(true);
    const review = (await checkEditTarget("state/auth.json", cwd, inside)) as {
      auto: false;
      review: unknown;
    };
    expect(review).toEqual({
      auto: false,
      review: { why: "protected path", target: join(inside, "auth.json") },
    });
    expect((await reviewOf(join(agentDir, "settings.json")))?.why).toBe("protected path");
  });

  it("protects the agent directory even when it does not exist yet", async () => {
    const missing = join(cwd, "not", "yet");
    expect((await checkEditTarget("not/yet/models.json", cwd, missing)).auto).toBe(false);
  });
});

describe("checkEditTarget: a session directory that is too broad gets no automatic edits", () => {
  const tooBroad = "session directory too broad for automatic edits";

  it("asks for everything when the session directory is the user's home", async () => {
    expect(await reviewOf(".bashrc", home)).toEqual({ why: tooBroad, target: join(home, ".bashrc") });
    expect((await reviewOf("project/src/a.ts", home))?.why).toBe(tooBroad);
  });

  it("asks for everything when the session directory contains the agent directory", async () => {
    expect((await reviewOf("proj/src/a.ts", base))?.why).toBe(tooBroad);
    expect((await checkEditTarget("x.ts", agentDir, agentDir)).auto).toBe(false);
  });

  it("asks for everything when the session directory is the filesystem root", async () => {
    expect((await reviewOf("tmp/x.ts", "/"))?.why).toBe(tooBroad);
  });

  it("still calls the home directory's agent files protected", async () => {
    expect(await checkEditTarget(".pi/agent/settings.json", home, join(home, ".pi", "agent"))).toEqual({
      auto: false,
      review: { why: "protected path", target: join(home, ".pi", "agent", "settings.json") },
    });
  });

  it("keeps a project inside the home directory automatic", async () => {
    const project = join(home, "code", "app");
    await mkdir(project, { recursive: true });
    expect(await isAuto("src/a.ts", project)).toBe(true);
  });
});

describe("checkEditTarget: what a review reports", () => {
  it("names the real target of a path that leaves the directory", async () => {
    expect(await reviewOf("../outside/new.txt")).toEqual({
      why: "outside the session directory",
      target: join(outside, "new.txt"),
    });
    await symlink("../outside", join(cwd, "assets"));
    expect(await reviewOf("assets/x.service")).toEqual({
      why: "outside the session directory",
      target: join(outside, "x.service"),
    });
  });

  it("has no target for a path it cannot read", async () => {
    expect(await check(undefined)).toEqual({ auto: false, review: { why: "outside the session directory" } });
  });
});
