import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError, type GitRunner } from "./runner.ts";
import { snapshotTree } from "./snapshot.ts";

const GIT_DIR = "/m/.git/worktrees/lane";
const TREE = "7".repeat(40);
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pap-skips-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (name: string): string => `:100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} M\0${name}\0`;

/** A runner whose `add` refuses any list that names `bad`, as git does for a file it cannot hash. */
function refusing(adds: string[][]): GitRunner {
  return {
    run: async (_root, args, options) => {
      const out = (text: string) => ({ stdout: Buffer.from(text), code: 0 });
      switch (args[0]) {
        case "diff":
          return out(entry("one") + entry("bad") + entry("two"));
        case "add": {
          const list = (options?.input?.toString("latin1") ?? "").split("\0").filter(Boolean);
          adds.push(list);
          if (list.includes("bad")) throw new GitError("failed");
          return out("");
        }
        case "write-tree":
          return out(`${TREE}\n`);
        case "rev-parse":
          return args[1] === "--git-path" ? out(`${join(dir, "none")}\n`) : out(`${"1".repeat(40)}\n`);
        default:
          return out("");
      }
    },
  };
}

describe("a file git refuses is left out and the capture goes on (I1)", () => {
  it("retries file by file on a rebuilt index and reports the one that failed", async () => {
    const adds: string[][] = [];
    const snap = await snapshotTree(refusing(adds), dir, GIT_DIR, join(dir, "tmp"));
    expect(snap).toMatchObject({ tree: TREE, skipped: 1 });
    expect(snap.left).toEqual([{ path: Buffer.from("bad"), reason: "unreadable" }]);
    expect(adds).toEqual([["one", "bad", "two"], ["one", "bad", "two"], ["one"], ["bad"], ["two"]]);
  });
});
