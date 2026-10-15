import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./runner.ts";
import { snapshotTree } from "./snapshot.ts";

const GIT_DIR = "/m/.git/worktrees/lane";
const TREE = "7".repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-snapshot-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
  args: readonly string[];
  env: Readonly<Record<string, string>> | undefined;
  input: Buffer | undefined;
}

/** Answers the reads a snapshot makes; `head` false is an unborn branch. */
function fake(realIndex: string, head: boolean): { git: GitRunner; calls: Call[] } {
  const calls: Call[] = [];
  const out = (text: string) => ({ stdout: Buffer.from(text), code: 0 });
  const git: GitRunner = {
    run: async (_root, args, options) => {
      calls.push({ args, env: options?.env, input: options?.input });
      switch (args[0]) {
        case "rev-parse":
          if (args[1] === "--git-path") return out(`${realIndex}\n`);
          return head ? out(`${"1".repeat(40)}\n`) : { stdout: Buffer.alloc(0), code: 1 };
        case "write-tree":
          return out(`${TREE}\n`);
        default:
          return out("");
      }
    },
  };
  return { git, calls };
}

describe("the temporary index is seeded by a copy of the real one (M9-RT-17)", () => {
  it("copies the index with its mtime and runs no read-tree", async () => {
    const real = join(dir, "index");
    writeFileSync(real, "index bytes");
    utimesSync(real, 1_700_000_000, 1_700_000_000);
    const indexDir = join(dir, "tmp");
    mkdirSync(indexDir);
    const { git, calls } = fake(real, true);
    let copiedMtime = 0;
    const spying: GitRunner = {
      run: async (root, args, options) => {
        const index = options?.env?.GIT_INDEX_FILE;
        if (args[0] === "diff" && index !== undefined) copiedMtime = statSync(index).mtimeMs;
        return git.run(root, args, options);
      },
    };
    const snap = await snapshotTree(spying, dir, GIT_DIR, indexDir);
    expect(snap).toEqual({ tree: TREE, skipped: 0, left: [] });
    expect(calls.some((call) => call.args[0] === "read-tree")).toBe(false);
    expect(copiedMtime).toBe(1_700_000_000_000);
    expect(readdirSync(indexDir)).toEqual([]);
  });

  it("runs read-tree HEAD under the temporary index when there is no real index", async () => {
    const indexDir = join(dir, "tmp");
    const { git, calls } = fake(join(dir, "missing-index"), true);
    await snapshotTree(git, dir, GIT_DIR, indexDir);
    const seed = calls.find((call) => call.args[0] === "read-tree");
    expect(seed?.args).toEqual(["read-tree", "HEAD"]);
    expect(seed?.env?.GIT_INDEX_FILE).toMatch(/\/tmp\/idx-[0-9a-f]{32}$/);
  });

  it("runs read-tree --empty on an unborn branch", async () => {
    const { git, calls } = fake(join(dir, "missing-index"), false);
    await snapshotTree(git, dir, GIT_DIR, join(dir, "tmp"));
    expect(calls.find((call) => call.args[0] === "read-tree")?.args).toEqual(["read-tree", "--empty"]);
  });

  it("gives every staging call the temporary index and the lane's git dir", async () => {
    const { git, calls } = fake(join(dir, "missing-index"), true);
    await snapshotTree(git, dir, GIT_DIR, join(dir, "tmp"));
    const indexes = new Set(
      calls.filter((call) => call.args[0] !== "rev-parse").map((call) => call.env?.GIT_INDEX_FILE),
    );
    expect(indexes.size).toBe(1);
    expect([...indexes][0]).toBeDefined();
  });
});

describe("staging never uses the walking forms (MC1 I3)", () => {
  it("lists the changes and stages them on stdin, NUL separated, in batches under the caps", async () => {
    const calls: Call[] = [];
    const tracked = Array.from(
      { length: 4097 },
      (_, at) => `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0f${at}\0`,
    );
    const git: GitRunner = {
      run: async (_root, args, options) => {
        calls.push({ args, env: options?.env, input: options?.input });
        if (args[0] === "diff") return { stdout: Buffer.from(tracked.join("")), code: 0 };
        if (args[0] === "write-tree") return { stdout: Buffer.from(`${TREE}\n`), code: 0 };
        if (args[0] === "rev-parse")
          return {
            stdout: Buffer.from(args[1] === "--git-path" ? `${join(dir, "no")}\n` : `${"1".repeat(40)}\n`),
            code: 0,
          };
        return { stdout: Buffer.alloc(0), code: 0 };
      },
    };
    await snapshotTree(git, dir, GIT_DIR, join(dir, "tmp"));
    const adds = calls.filter((call) => call.args[0] === "add");
    expect(adds.map((call) => call.args)).toEqual([
      ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
      ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
    ]);
    expect(adds.map((call) => call.input?.toString("utf8").split("\0").length)).toEqual([4097, 2]);
    expect(calls.some((call) => call.args.includes("-u") || call.args.includes("-A"))).toBe(false);
  });
});
