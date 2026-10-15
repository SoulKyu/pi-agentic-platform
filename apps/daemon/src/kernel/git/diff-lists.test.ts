import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { diffList, MAX_REVIEW_FILES, mergeDiffLists } from "./diff-lists.ts";
import type { GitRunner } from "./runner.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const ZERO = "0".repeat(40);
const raw = (...records: string[]): Buffer => Buffer.from(records.join(""), "utf8");

describe("mergeDiffLists (M9R56)", () => {
  it("merges --raw and --numstat by path: A, M, D, R with its old path, T and a binary file", () => {
    const rawOut = raw(
      `:000000 100644 ${ZERO} ${A} A\0new.ts\0`,
      `:100644 100644 ${A} ${B} M\0mod.ts\0`,
      `:100644 000000 ${C} ${ZERO} D\0gone.ts\0`,
      `:100644 100644 ${A} ${A} R087\0old.ts\0moved.ts\0`,
      `:100644 120000 ${A} ${B} T\0link\0`,
      `:100644 100644 ${A} ${C} M\0img.png\0`,
    );
    const numstat = Buffer.from(
      "3\t0\tnew.ts\0" +
        "2\t1\tmod.ts\0" +
        "0\t4\tgone.ts\0" +
        "1\t1\t\0old.ts\0moved.ts\0" +
        "1\t1\tlink\0" +
        "-\t-\timg.png\0",
    );
    const { logger } = captureLogger();
    const { files } = mergeDiffLists(rawOut, numstat, logger);
    expect(files).toEqual([
      { path: "new.ts", oldPath: null, status: "A", additions: 3, deletions: 0, binary: false, identity: A },
      { path: "mod.ts", oldPath: null, status: "M", additions: 2, deletions: 1, binary: false, identity: B },
      {
        path: "gone.ts",
        oldPath: null,
        status: "D",
        additions: 0,
        deletions: 4,
        binary: false,
        identity: "deleted",
      },
      {
        path: "moved.ts",
        oldPath: "old.ts",
        status: "R",
        additions: 1,
        deletions: 1,
        binary: false,
        identity: A,
      },
      { path: "link", oldPath: null, status: "T", additions: 1, deletions: 1, binary: false, identity: B },
      {
        path: "img.png",
        oldPath: null,
        status: "M",
        additions: null,
        deletions: null,
        binary: true,
        identity: C,
      },
    ]);
  });

  it("cuts at 2 000 files and says so", () => {
    const records = Array.from(
      { length: MAX_REVIEW_FILES + 1 },
      (_, at) => `:100644 100644 ${A} ${B} M\0f${at}\0`,
    );
    const merged = mergeDiffLists(raw(...records), Buffer.alloc(0), captureLogger().logger);
    expect(merged.files).toHaveLength(MAX_REVIEW_FILES);
    expect(merged.truncated).toBe(true);
    const exact = mergeDiffLists(
      raw(...records.slice(0, MAX_REVIEW_FILES)),
      Buffer.alloc(0),
      captureLogger().logger,
    );
    expect(exact.truncated).toBe(false);
  });

  it("drops a path with a newline or U+202E and logs the count", () => {
    const { logger, lines } = captureLogger();
    const rawOut = raw(
      `:100644 100644 ${A} ${B} M\0bad\nname\0`,
      `:100644 100644 ${A} ${B} M\0evil\u202Efdp.txt\0`,
      `:100644 100644 ${A} ${B} M\0fine.txt\0`,
    );
    const { files } = mergeDiffLists(rawOut, Buffer.alloc(0), logger);
    expect(files.map((file) => file.path)).toEqual(["fine.txt"]);
    expect(lines.find((line) => line.msg === "review_path_dropped")).toMatchObject({ count: 2 });
  });

  it("drops a rename whose old path is unusable", () => {
    const { logger, lines } = captureLogger();
    const { files } = mergeDiffLists(
      raw(`:100644 100644 ${A} ${A} R100\0bad\u200Bold\0new\0`),
      Buffer.alloc(0),
      logger,
    );
    expect(files).toEqual([]);
    expect(lines.some((line) => line.msg === "review_path_dropped")).toBe(true);
  });
});

describe("diffList runs the two diffs between the sides", () => {
  it("passes both argument lists, with the lane's git dir", async () => {
    const calls: Array<{ args: readonly string[]; gitDir: string | undefined }> = [];
    const git: GitRunner = {
      run: async (_root, args, options) => {
        calls.push({ args, gitDir: options?.gitDir });
        return { stdout: Buffer.alloc(0), code: 0 };
      },
    };
    const from = "1".repeat(40);
    const to = "2".repeat(40);
    const gitDir = "/m/.git/worktrees/lane";
    const out = await diffList(git, "/r", gitDir, from, to, captureLogger().logger);
    expect(out).toEqual({ files: [], truncated: false });
    expect(calls.map((call) => call.args)).toEqual([
      ["diff", "--raw", "-z", "-M", "--no-abbrev", from, to, "--"],
      ["diff", "--numstat", "-z", "-M", from, to, "--"],
    ]);
    expect(calls.every((call) => call.gitDir === gitDir)).toBe(true);
  });
});
