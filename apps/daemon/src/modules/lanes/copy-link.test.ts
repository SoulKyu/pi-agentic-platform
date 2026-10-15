import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { applyCopyLink } from "./copy-link.ts";

const GIT_DIR = "/x/.git/worktrees/lane";

let dir: string;
let root: string;
let worktree: string;
let outside: string;
let ignoredInRoot: Set<string>;
let ignoredInWorktree: Set<string>;
let calls: Array<{ cwd: string; args: readonly string[]; gitDir: string | undefined }>;
let log: string[];

/** A runner that answers `check-ignore --stdin` from a list per folder: the real answers are the real-git tests' business. */
const git: GitRunner = {
  async run(cwd, args, options) {
    calls.push({ cwd, args, gitDir: options?.gitDir });
    if (args[0] !== "check-ignore") throw new Error("unexpected git call");
    const asked = (options?.input?.toString("utf8") ?? "").split("\0").filter((path) => path !== "");
    const list = cwd === root ? ignoredInRoot : ignoredInWorktree;
    const matched = asked.filter((path) => list.has(path));
    return {
      stdout: Buffer.from(matched.map((path) => `${path}\0`).join("")),
      code: matched.length > 0 ? 0 : 1,
    };
  },
};

const bothIgnore = (path: string): void => {
  ignoredInRoot.add(path);
  ignoredInWorktree.add(path);
};

const file = (path: string, content = "x", mode?: number): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, mode === undefined ? undefined : { mode });
};

const run = (over: Partial<Parameters<typeof applyCopyLink>[0]> = {}) =>
  applyCopyLink({
    root,
    worktree,
    gitDir: GIT_DIR,
    copy: [],
    link: [],
    git,
    boundary: { papHome: [], agentDir: [], home: [], papHomeOpen: [], runtimeDirs: [] },
    deny: { has: async () => false, warm: () => {} },
    denyFolders: [],
    log: (line) => log.push(line),
    diskFloor: async () => {},
    ...over,
  });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-copylink-")));
  root = join(dir, "main");
  worktree = join(dir, "lane");
  outside = join(dir, "outside");
  for (const folder of [root, worktree, outside]) mkdirSync(folder);
  ignoredInRoot = new Set();
  ignoredInWorktree = new Set();
  calls = [];
  log = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("copy", () => {
  it("copies an ignored file with its mode", async () => {
    file(join(root, ".env"), "SECRET=1\n", 0o600);
    bothIgnore("./.env");
    expect(await run({ copy: [".env"] })).toEqual({ skipped: 0 });
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("SECRET=1\n");
    expect(statSync(join(worktree, ".env")).mode & 0o777).toBe(0o600);
    expect(log).toEqual([]);
  });

  it("asks git about the owner's checkout with the path after ./ on stdin", async () => {
    file(join(root, ".env"));
    bothIgnore("./.env");
    await run({ copy: [".env"] });
    expect(calls[0]).toMatchObject({ cwd: root, args: ["check-ignore", "-z", "--stdin", "--no-index"] });
  });

  it("skips a .env that is a symlink to a file outside the checkout", async () => {
    file(join(outside, "secret"), "stolen");
    symlinkSync(join(outside, "secret"), join(root, ".env"));
    bothIgnore("./.env");
    expect(await run({ copy: [".env"] })).toEqual({ skipped: 1 });
    expect(existsSync(join(worktree, ".env"))).toBe(false);
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('".env"');
    expect(log[0]).toContain("outside");
  });

  it("skips a symlink that leads into .git inside the checkout", async () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    symlinkSync(join(root, ".git", "hooks"), join(root, "hooks"));
    bothIgnore("./hooks");
    expect(await run({ copy: ["hooks"] })).toEqual({ skipped: 1 });
    expect(existsSync(join(worktree, "hooks"))).toBe(false);
    expect(log[0]).toContain("outside");
  });

  it("skips a source that is not ignored", async () => {
    file(join(root, "src", "x"));
    expect(await run({ copy: ["src/x"] })).toEqual({ skipped: 1 });
    expect(existsSync(join(worktree, "src", "x"))).toBe(false);
    expect(log[0]).toContain("not_ignored");
  });

  it("skips a source that does not exist", async () => {
    bothIgnore("./.env");
    expect(await run({ copy: [".env"] })).toEqual({ skipped: 1 });
    expect(log[0]).toContain("missing");
  });

  it("keeps an existing destination", async () => {
    file(join(root, ".env"), "new");
    file(join(worktree, ".env"), "old");
    bothIgnore("./.env");
    expect(await run({ copy: [".env"] })).toEqual({ skipped: 1 });
    expect(readFileSync(join(worktree, ".env"), "utf8")).toBe("old");
    expect(log[0]).toContain("exists");
  });

  it("copies a folder and leaves a nested symlink that escapes behind", async () => {
    file(join(root, "cfg", "a.txt"), "a");
    file(join(outside, "target"), "t");
    symlinkSync(join(outside, "target"), join(root, "cfg", "abs"));
    symlinkSync("../../outside/target", join(root, "cfg", "rel"));
    symlinkSync("a.txt", join(root, "cfg", "inside"));
    // Inside the checkout as it resolves here, but one `..` too many for the lane's copy: from the lane it reaches the owner's folder.
    symlinkSync("../../main/cfg/a.txt", join(root, "cfg", "back"));
    symlinkSync(join(root, "cfg", "a.txt"), join(root, "cfg", "absinside"));
    bothIgnore("./cfg");
    await run({ copy: ["cfg"] });
    expect(readFileSync(join(worktree, "cfg", "a.txt"), "utf8")).toBe("a");
    expect(existsSync(join(worktree, "cfg", "abs"))).toBe(false);
    for (const name of ["back", "absinside"])
      expect(lstatSync(join(worktree, "cfg", name), { throwIfNoEntry: false }), name).toBeUndefined();
    expect(lstatSync(join(worktree, "cfg", "rel"), { throwIfNoEntry: false })).toBeUndefined();
    expect(readlinkSync(join(worktree, "cfg", "inside"))).toBe("a.txt");
  });

  it("creates the destination parent inside the worktree", async () => {
    file(join(root, "a", "b", ".env"), "x");
    bothIgnore("./a/b/.env");
    await run({ copy: ["a/b/.env"] });
    expect(readFileSync(join(worktree, "a", "b", ".env"), "utf8")).toBe("x");
  });

  it("refuses a destination parent that is a symlink out of the worktree", async () => {
    file(join(root, "a", ".env"), "x");
    symlinkSync(outside, join(worktree, "a"));
    bothIgnore("./a/.env");
    expect(await run({ copy: ["a/.env"] })).toEqual({ skipped: 1 });
    expect(existsSync(join(outside, ".env"))).toBe(false);
    expect(log[0]).toContain("outside");
  });

  it("stops at the size cap and skips the rest", async () => {
    file(join(root, "small"), "12345");
    file(join(root, "big"), "x".repeat(20));
    file(join(root, "later"), "1234");
    for (const name of ["small", "big", "later"]) bothIgnore(`./${name}`);
    const result = await run({ copy: ["small", "big", "later"], copyCapBytes: 10 });
    expect(result).toEqual({ skipped: 1 });
    expect(existsSync(join(worktree, "small"))).toBe(true);
    expect(existsSync(join(worktree, "big"))).toBe(false);
    expect(readFileSync(join(worktree, "later"), "utf8")).toBe("1234");
    expect(log[0]).toContain("cap");
  });

  it("skips the copy when the disk floor throws", async () => {
    file(join(root, ".env"));
    bothIgnore("./.env");
    const result = await run({
      copy: [".env"],
      diskFloor: async () => {
        throw new Error("full");
      },
    });
    expect(result).toEqual({ skipped: 1 });
    expect(existsSync(join(worktree, ".env"))).toBe(false);
    expect(log[0]).toContain("disk");
  });

  it("writes one log line per skip and keeps a name with a newline on one line", async () => {
    const odd = "a\nb: fake line";
    file(join(root, odd));
    file(join(root, "src", "x"));
    const result = await run({ copy: [odd, "src/x", "nope"] });
    expect(result).toEqual({ skipped: 3 });
    expect(log).toHaveLength(3);
    expect(log[0]).toContain("not_ignored");
    for (const line of log) expect(line).not.toContain("\n");
  });
});

describe("link", () => {
  it("links to the real source when the entry is ignored in the lane too", async () => {
    mkdirSync(join(root, "node_modules"));
    ignoredInRoot.add("./node_modules");
    ignoredInWorktree.add("./node_modules");
    expect(await run({ link: ["node_modules"] })).toEqual({ skipped: 0 });
    expect(readlinkSync(join(worktree, "node_modules"))).toBe(join(root, "node_modules"));
    expect(calls.at(-1)).toMatchObject({
      cwd: worktree,
      args: ["check-ignore", "-z", "--stdin", "--no-index"],
      gitDir: GIT_DIR,
    });
  });

  it("undoes the link and names the fix when only `node_modules/` is ignored", async () => {
    mkdirSync(join(root, "node_modules"));
    ignoredInRoot.add("./node_modules"); // the folder matches `node_modules/`; its link does not
    expect(await run({ link: ["node_modules"] })).toEqual({ skipped: 1 });
    expect(lstatSync(join(worktree, "node_modules"), { throwIfNoEntry: false })).toBeUndefined();
    expect(log).toHaveLength(1);
    expect(log[0]).toContain("add `/node_modules` (no trailing slash) to .gitignore to link it");
  });

  it("skips a link source that is not ignored in the owner's checkout", async () => {
    mkdirSync(join(root, "vendor"));
    expect(await run({ link: ["vendor"] })).toEqual({ skipped: 1 });
    expect(lstatSync(join(worktree, "vendor"), { throwIfNoEntry: false })).toBeUndefined();
    expect(calls.every((call) => call.cwd === root)).toBe(true);
  });

  it("never links a source outside the checkout", async () => {
    mkdirSync(join(outside, "deps"));
    symlinkSync(join(outside, "deps"), join(root, "deps"));
    ignoredInRoot.add("./deps");
    ignoredInWorktree.add("./deps");
    expect(await run({ link: ["deps"] })).toEqual({ skipped: 1 });
    expect(lstatSync(join(worktree, "deps"), { throwIfNoEntry: false })).toBeUndefined();
  });

  it("keeps an existing destination", async () => {
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(worktree, "node_modules"));
    ignoredInRoot.add("./node_modules");
    ignoredInWorktree.add("./node_modules");
    expect(await run({ link: ["node_modules"] })).toEqual({ skipped: 1 });
    expect(lstatSync(join(worktree, "node_modules")).isSymbolicLink()).toBe(false);
  });
});
