import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRunner } from "../../kernel/git/runner.ts";
import { applyCopyLink, COPY_MAX_FILES, CopyLimitError } from "./copy-link.ts";

let dir: string;
let root: string;
let worktree: string;

/** Everything asked is ignored, in the main checkout and in the lane. */
const git: GitRunner = {
  async run(_cwd, _args, options) {
    return { stdout: options?.input ?? Buffer.alloc(0), code: 0 };
  },
};

const run = (over: Partial<Parameters<typeof applyCopyLink>[0]> = {}) =>
  applyCopyLink({
    root,
    worktree,
    gitDir: "/x/.git/worktrees/lane",
    copy: [],
    link: [],
    git,
    boundary: { papHome: [], agentDir: [], home: [], papHomeOpen: [], runtimeDirs: [] },
    deny: { has: async () => false, warm: () => {} },
    denyFolders: [],
    log: () => undefined,
    diskFloor: async () => {},
    ...over,
  });

const filesIn = (name: string, count: number): void => {
  mkdirSync(join(root, name), { recursive: true });
  for (let n = 0; n < count; n++) writeFileSync(join(root, name, `f${n}`), "x");
};

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-copylimits-")));
  root = join(dir, "main");
  worktree = join(dir, "lane");
  mkdirSync(root);
  mkdirSync(worktree);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("the copy limits", () => {
  it("caps the files of a lane's copies at 100 000", () => expect(COPY_MAX_FILES).toBe(100_000));

  it("fails with a CopyLimitError when a copy holds more files than the cap, and stops copying", async () => {
    filesIn("cache", 5);
    const failure = await run({ copy: ["cache"], copyMaxFiles: 3 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(CopyLimitError);
    expect(readdirSync(join(worktree, "cache")).length).toBeLessThanOrEqual(3);
  });

  it("counts the files of all copies together", async () => {
    filesIn("one", 2);
    filesIn("two", 2);
    await expect(run({ copy: ["one", "two"], copyMaxFiles: 3 })).rejects.toBeInstanceOf(CopyLimitError);
  });

  it("copies exactly the cap", async () => {
    filesIn("cache", 3);
    await expect(run({ copy: ["cache"], copyMaxFiles: 3 })).resolves.toEqual({ skipped: 0 });
    expect(readdirSync(join(worktree, "cache"))).toHaveLength(3);
  });

  it("stops at an aborted signal: the remaining entries are not copied and the call rejects", async () => {
    filesIn("a", 1);
    filesIn("b", 1);
    const controller = new AbortController();
    const failure = await run({
      copy: ["a", "b"],
      signal: controller.signal,
      diskFloor: async () => controller.abort(),
    }).catch((error: unknown) => error);
    expect((failure as Error).name).toBe("AbortError");
    expect(existsSync(join(worktree, "b"))).toBe(false);
  });

  it("does not start with a signal that is already aborted", async () => {
    filesIn("a", 1);
    const controller = new AbortController();
    controller.abort();
    await expect(run({ copy: ["a"], signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(existsSync(join(worktree, "a"))).toBe(false);
  });
});
