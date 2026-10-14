import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type VcsFile, VcsStatus, VcsStreamEvent } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import type { LineCounter } from "./line-counts.ts";
import { readStatus } from "./status.ts";
import { type FakeAnswer, fakeGit } from "./testing/vcs-bed.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "pap-vcs-status-")));
  mkdirSync(join(root, ".git"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const HEADER = [
  "# branch.oid 1111",
  "# branch.head main",
  "# branch.upstream origin/main",
  "# branch.ab +2 -1",
];
const porcelain = (entries: readonly string[], header: readonly string[] = HEADER): Buffer =>
  Buffer.from([...header, ...entries].map((record) => `${record}\0`).join(""));
const ordinary = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 aaaa bbbb ${path}`;

const NOW = 1_700_000_000_000;
function run(
  answers: { status?: FakeAnswer; diff?: FakeAnswer },
  counter: LineCounter | null = null,
): Promise<VcsStatus> & { calls: string[][] } {
  const { git, calls } = fakeGit((args) =>
    args[0] === "status" ? (answers.status ?? "") : (answers.diff ?? ""),
  );
  const promise = readStatus(
    { git, logger: silentLogger, now: () => NOW },
    root,
    counter,
  ) as Promise<VcsStatus> & {
    calls: string[][];
  };
  promise.calls = calls;
  return promise;
}

describe("what a status says", () => {
  it("maps each porcelain record to its kind, with the old path of a rename", async () => {
    const status = await run({
      status: porcelain([
        ordinary(".M", "mod.txt"),
        ordinary("A.", "new.txt"),
        ordinary(".D", "gone.txt"),
        ordinary("D.", "staged-gone.txt"),
        ordinary(".T", "link"),
        `2 R. N... 100644 100644 100644 aaaa bbbb R100 d.txt\0c.txt`,
        `2 C. N... 100644 100644 100644 aaaa bbbb C100 copy.txt\0orig.txt`,
        `u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflict.txt`,
        "? b.txt",
        "? u/",
      ]),
    });
    expect(status.files.map((f) => [f.path, f.oldPath, f.kind, f.index, f.worktree, f.folder])).toEqual([
      ["mod.txt", null, "modified", ".", "M", false],
      ["new.txt", null, "added", "A", ".", false],
      ["gone.txt", null, "deleted", ".", "D", false],
      ["staged-gone.txt", null, "deleted", "D", ".", false],
      ["link", null, "typechange", ".", "T", false],
      ["d.txt", "c.txt", "renamed", "R", ".", false],
      ["copy.txt", "orig.txt", "copied", "C", ".", false],
      ["conflict.txt", null, "conflicted", "U", "U", false],
      ["b.txt", null, "untracked", "?", "?", false],
      ["u", null, "untracked", "?", "?", true],
    ]);
    expect(VcsStatus.safeParse(status).success).toBe(true);
  });

  it("reads the branch, its upstream and how far it is ahead and behind", async () => {
    const status = await run({ status: porcelain([]) });
    expect(status).toEqual({
      root,
      repo: true,
      branch: "main",
      detached: false,
      upstream: "origin/main",
      ahead: 2,
      behind: 1,
      files: [],
      truncated: false,
      additions: 0,
      deletions: 0,
      at: NOW,
      error: null,
    });
  });

  it("reports a detached head without a branch", async () => {
    const status = await run({ status: porcelain([], ["# branch.oid 1111", "# branch.head (detached)"]) });
    expect([status.branch, status.detached, status.upstream, status.ahead, status.behind]).toEqual([
      null,
      true,
      null,
      0,
      0,
    ]);
  });

  it("lands numstat counts on their files; a binary row gives binary and null counts; totals add up", async () => {
    const status = await run({
      status: porcelain([
        ordinary(".M", "a.txt"),
        ordinary(".M", "bin.dat"),
        `2 R. N... 100644 100644 100644 aaaa bbbb R100 d.txt\0c.txt`,
        ordinary(".M", "no-row.txt"),
      ]),
      diff: "3\t1\ta.txt\0-\t-\tbin.dat\0" + "2\t0\t\0c.txt\0d.txt\0",
    });
    expect(status.files.map((f) => [f.path, f.additions, f.deletions, f.binary])).toEqual([
      ["a.txt", 3, 1, false],
      ["bin.dat", null, null, true],
      ["d.txt", 2, 0, false],
      ["no-row.txt", null, null, false],
    ]);
    expect([status.additions, status.deletions]).toEqual([5, 1]);
  });

  it("runs the planned argv and never passes --untracked-files (the repository's own setting decides)", async () => {
    const pending = run({ status: porcelain([ordinary(".M", "a.txt")]) });
    await pending;
    expect(pending.calls).toEqual([
      ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"],
      ["diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", "HEAD", "--"],
    ]);
    expect(pending.calls.flat().some((arg) => arg.startsWith("--untracked-files"))).toBe(false);
  });

  it("runs no numstat on an unborn branch", async () => {
    const pending = run({ status: porcelain(["? a.txt"], ["# branch.oid (initial)", "# branch.head main"]) });
    const status = await pending;
    expect(pending.calls.map((call) => call[0])).toEqual(["status"]);
    expect(status.branch).toBe("main");
  });
});

describe("untracked files and folders", () => {
  const counter = (counts: Record<string, { additions: number | null; binary: boolean }>) => {
    const seen: string[] = [];
    const lines: LineCounter = {
      beginRun: () => void seen.push("run"),
      count: async (path) => {
        seen.push(path);
        return counts[path] ?? { additions: null, binary: false };
      },
    };
    return { lines, seen };
  };

  it("counts the lines of an untracked file as additions and gives a folder entry no counts and no read", async () => {
    const { lines, seen } = counter({
      "b.txt": { additions: 4, binary: false },
      "c.bin": { additions: null, binary: true },
    });
    const status = await run({ status: porcelain(["? b.txt", "? c.bin", "? u/"]) }, lines);
    expect(status.files.map((f) => [f.path, f.folder, f.additions, f.deletions, f.binary])).toEqual([
      ["b.txt", false, 4, 0, false],
      ["c.bin", false, null, null, true],
      ["u", true, null, null, false],
    ]);
    expect(seen).toEqual(["run", "b.txt", "c.bin"]);
    expect([status.additions, status.deletions]).toEqual([4, 0]);
  });

  it("reads no file when it is given no counter", async () => {
    const status = await run({ status: porcelain(["? b.txt"]) }, null);
    expect(status.files.map((f) => [f.additions, f.deletions])).toEqual([[null, null]]);
  });
});

describe("bounds", () => {
  it("keeps 2000 files of 2001 and says it was cut", async () => {
    const entries = Array.from({ length: 2001 }, (_, i) => ordinary(".M", `f${String(i).padStart(4, "0")}`));
    const status = await run({ status: porcelain(entries) });
    expect(status.files).toHaveLength(2000);
    expect(status.files.at(-1)?.path).toBe("f1999");
    expect(status.truncated).toBe(true);
  });

  it("cuts 2000 long paths from the end so the event fits 900 000 bytes", async () => {
    const entries = Array.from({ length: 2000 }, (_, i) =>
      ordinary(".M", `${"d".repeat(590)}${String(i).padStart(4, "0")}`),
    );
    const status = await run({ status: porcelain(entries) });
    const event = (s: VcsStatus) => ({ kind: "snapshot" as const, status: s });
    expect(status.truncated).toBe(true);
    expect(sizeOf(event(status))).toBeLessThanOrEqual(PAGE_BYTES);
    expect(VcsStreamEvent.safeParse(event(status)).success).toBe(true);
    // The longest prefix that fits: one more file would pass the limit.
    const next = {
      ...(status.files[0] as VcsFile),
      path: `${"d".repeat(590)}${String(status.files.length).padStart(4, "0")}`,
    };
    expect(sizeOf(event({ ...status, files: [...status.files, next] }))).toBeGreaterThan(PAGE_BYTES);
  });

  it("clips a 300-character branch to 256 and an upstream to 512, and the schema passes", async () => {
    const status = await run({
      status: porcelain([], [`# branch.head ${"b".repeat(300)}`, `# branch.upstream ${"u".repeat(600)}`]),
    });
    expect([status.branch?.length, status.upstream?.length]).toEqual([256, 512]);
    expect(VcsStatus.safeParse(status).success).toBe(true);
  });

  it("does not cut a branch name in the middle of a surrogate pair", async () => {
    const status = await run({ status: porcelain([], [`# branch.head ${"b".repeat(255)}\u{1F600}x`]) });
    expect(status.branch).toBe("b".repeat(255));
  });

  it("skips a path the schema would refuse and says the list is incomplete", async () => {
    const status = await run({
      status: porcelain([ordinary(".M", "ok.txt"), ordinary(".M", "x".repeat(5000))]),
    });
    expect(status.files.map((f) => f.path)).toEqual(["ok.txt"]);
    expect(status.truncated).toBe(true);
    expect(VcsStatus.safeParse(status).success).toBe(true);
  });
});

describe("failures never throw", () => {
  it("answers git_missing with no repository state, the root and an empty list", async () => {
    const status = await run({ status: new GitError("git_missing") });
    expect(status).toEqual({
      root,
      repo: false,
      branch: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      truncated: false,
      additions: 0,
      deletions: 0,
      at: NOW,
      error: "git_missing",
    });
  });

  it("maps timeout, too_large and failed of either run", async () => {
    for (const kind of ["timeout", "too_large", "failed"] as const) {
      const first = await run({ status: new GitError(kind) });
      expect([first.error, first.repo, first.files]).toEqual([kind, true, []]);
      const second = await run({ status: porcelain([ordinary(".M", "a")]), diff: new GitError(kind) });
      expect([second.error, second.repo, second.files]).toEqual([kind, true, []]);
    }
  });

  it("answers an unexpected error as failed", async () => {
    const status = await run({ status: new Error("boom") });
    expect([status.error, status.repo]).toEqual(["failed", true]);
  });

  it("says repo: false for a folder without .git and starts no git", async () => {
    rmSync(join(root, ".git"), { recursive: true });
    const pending = run({ status: "never" });
    const status = await pending;
    expect([status.repo, status.error, status.files, status.branch]).toEqual([false, null, [], null]);
    expect(pending.calls).toEqual([]);
  });
});
