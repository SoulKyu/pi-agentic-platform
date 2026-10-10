import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isInsideCwd } from "./target-path.ts";

let base: string;
let cwd: string;
let outside: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "pap-target-path-")));
  cwd = join(base, "proj");
  outside = join(base, "outside");
  await mkdir(join(cwd, "src"), { recursive: true });
  await mkdir(join(cwd, "..hidden"), { recursive: true });
  await mkdir(join(base, "proj-evil"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(cwd, "src", "a.ts"), "x");
  await writeFile(join(outside, "secret.txt"), "x");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("isInsideCwd: plain paths", () => {
  it.each([
    "src/a.ts",
    "./src/a.ts",
    "src/new.ts",
    "src/deep/er/new.ts",
    "src/../src/a.ts",
    "..hidden/f",
    ".",
  ])("accepts %j", async (path) => {
    expect(await isInsideCwd(path, cwd)).toBe(true);
  });

  it("accepts an absolute path inside the directory, existing or not", async () => {
    expect(await isInsideCwd(join(cwd, "src", "a.ts"), cwd)).toBe(true);
    expect(await isInsideCwd(join(cwd, "src", "later.ts"), cwd)).toBe(true);
  });

  it("accepts paths through a symlinked cwd", async () => {
    await symlink(cwd, join(base, "alias"), "dir");
    expect(await isInsideCwd("src/a.ts", join(base, "alias"))).toBe(true);
    expect(await isInsideCwd(join(base, "alias", "src", "new.ts"), cwd)).toBe(true);
  });
});

describe("isInsideCwd: traversal and absolute escapes", () => {
  it.each([
    "../outside/secret.txt",
    "../outside/new.txt",
    "src/../../outside/new.txt",
    "../proj-evil/a.ts",
    "..",
  ])("rejects %j", async (path) => {
    expect(await isInsideCwd(path, cwd)).toBe(false);
  });

  it("rejects absolute paths outside the directory and the sibling that shares its prefix", async () => {
    expect(await isInsideCwd(join(outside, "secret.txt"), cwd)).toBe(false);
    expect(await isInsideCwd(join(base, "proj-evil", "a.ts"), cwd)).toBe(false);
    expect(await isInsideCwd("/etc/passwd", cwd)).toBe(false);
  });
});

describe("isInsideCwd: symlinks", () => {
  it("rejects a directory symlink that leaves the directory, existing or new target", async () => {
    await symlink(outside, join(cwd, "link"), "dir");
    expect(await isInsideCwd("link/secret.txt", cwd)).toBe(false);
    expect(await isInsideCwd("link/new.txt", cwd)).toBe(false);
    expect(await isInsideCwd("link/new/dir/new.txt", cwd)).toBe(false);
  });

  it("rejects a file symlink to a file outside the directory", async () => {
    await symlink(join(outside, "secret.txt"), join(cwd, "leak.txt"));
    expect(await isInsideCwd("leak.txt", cwd)).toBe(false);
  });

  it("rejects a dangling symlink whose target would be created outside", async () => {
    await symlink(join(outside, "not-yet.txt"), join(cwd, "dangling.txt"));
    expect(await isInsideCwd("dangling.txt", cwd)).toBe(false);
  });

  it("rejects a chain of symlinks whose last hop leaves the directory", async () => {
    await symlink(join(outside, "not-yet.txt"), join(cwd, "hop2"));
    await symlink("hop2", join(cwd, "hop1"));
    expect(await isInsideCwd("hop1", cwd)).toBe(false);
  });

  it("resolves a relative dangling link from the real directory it lives in", async () => {
    await symlink(outside, join(cwd, "link"), "dir");
    await symlink("../not-yet.txt", join(outside, "rel"));
    expect(await isInsideCwd("link/rel", cwd)).toBe(false);
  });

  it("accepts a symlink that stays inside the directory", async () => {
    await symlink(join(cwd, "src"), join(cwd, "alias"), "dir");
    await symlink("a.ts", join(cwd, "src", "a-link.ts"));
    expect(await isInsideCwd("alias/new.ts", cwd)).toBe(true);
    expect(await isInsideCwd("src/a-link.ts", cwd)).toBe(true);
  });

  it("fails instead of looping on a symlink cycle", async () => {
    await symlink("b", join(cwd, "a"));
    await symlink("a", join(cwd, "b"));
    await expect(isInsideCwd("a", cwd)).rejects.toThrow();
  });
});

describe("isInsideCwd: spellings Pi rewrites before it touches the file", () => {
  it.each(["~/elsewhere.txt", "~", "@/etc/passwd", "@../outside/new.txt", "file:///etc/passwd"])(
    "rejects %j",
    async (path) => {
      expect(await isInsideCwd(path, cwd)).toBe(false);
    },
  );

  it("reads a no-break space as the ordinary space Pi turns it into", async () => {
    await symlink(outside, join(cwd, "link "), "dir");
    const noBreakSpace = String.fromCharCode(0xa0);
    expect(await isInsideCwd(`link${noBreakSpace}/new.txt`, cwd)).toBe(false);
  });

  it("accepts the @ prefix when the rest stays inside", async () => {
    expect(await isInsideCwd("@src/a.ts", cwd)).toBe(true);
  });

  it("rejects a file URL with a foreign host instead of guessing", async () => {
    await expect(isInsideCwd("file://example.com/etc/passwd", cwd)).rejects.toThrow();
  });
});

describe("isInsideCwd: malformed input", () => {
  it.each([undefined, null, 42, {}, ["src/a.ts"], "", "src/a\0.ts"])("rejects %j", async (path) => {
    expect(await isInsideCwd(path, cwd)).toBe(false);
  });
});
