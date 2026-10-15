import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { GitError, type GitRunner, type GitRunOptions } from "../../kernel/git/runner.ts";
import { silentLogger } from "../../kernel/logger.ts";
import { testCaller } from "../../testing/caller.ts";
import { createCommitter } from "./git-ops.ts";
import { createLaneLocks } from "./lane-lock.ts";
import type { LaneRow } from "./store.ts";

const OID = "a".repeat(40);
const GIT_DIR = "/repo/.git/worktrees/lane-1";
const row = { id: "lane-1", ownerId: "u1", worktree: "/wt/lane-1", state: "active" } as LaneRow;
const HEAD = "# branch.oid abc\0# branch.head pi/x\0";
const ordinary = (path: string, xy = ".M") => `1 ${xy} N... 100644 100644 100644 h1 h2 ${path}\0`;
const gitlink = (path: string) => `1 .M S.M. 160000 160000 160000 h1 h2 ${path}\0`;
const deleted = (path: string) => `1 .D N... 100644 100644 000000 h1 h2 ${path}\0`;
const unmerged = (path: string) => `u UU N... 100644 100644 100644 100644 h1 h2 h3 ${path}\0`;
const renamed = (path: string, from: string) =>
  `2 R. N... 100644 100644 100644 h1 h2 R100 ${path}\0${from}\0`;
const untracked = (path: string) => `? ${path}\0`;

interface Call {
  root: string;
  args: string[];
  options: GitRunOptions;
}
interface Script {
  /** Paths of the add list that git embeds as nested repositories (mode 160000, new). */
  embedded?: string[];
  status?: string;
  add?: { code: number; stdout?: string; stderr?: string } | GitError;
  commit?: { code: number; stdout?: string; stderr?: string } | GitError;
}

const rawEntry = (mode: string, path: string) =>
  `:000000 ${mode} ${"0".repeat(40)} ${"1".repeat(40)} A\0${path}\0`;

function fake(script: Script) {
  const calls: Call[] = [];
  let staged: string[] = [];
  let removed = false;
  const git: GitRunner = {
    async run(root, args, options = {}) {
      calls.push({ root, args: [...args], options });
      const answer = (run: { code: number; stdout?: string; stderr?: string } | GitError | undefined) => {
        if (run instanceof GitError) throw run;
        return { stdout: Buffer.from(run?.stdout ?? ""), code: run?.code ?? 0, stderr: run?.stderr ?? "" };
      };
      switch (args[0]) {
        case "status":
          return { stdout: Buffer.from(HEAD + (script.status ?? "")), code: 0 };
        case "add":
          staged = (options.input?.toString("utf8") ?? "").split("\0").filter(Boolean);
          return answer(script.add);
        case "diff": {
          const embedded = script.embedded ?? [];
          const entries = staged
            .filter((path) => !(removed && embedded.includes(path)))
            .map((path) =>
              rawEntry(
                embedded.includes(path) ? "160000" : "100644",
                embedded.includes(path)
                  ? path.replace(/\/$/, "")
                  : path.endsWith("/")
                    ? `${path}f.txt`
                    : path,
              ),
            );
          return { stdout: Buffer.from(entries.join("")), code: 0 };
        }
        case "rm":
          removed = true;
          return { stdout: Buffer.alloc(0), code: 0 };
        case "commit":
          return answer(script.commit);
        case "rev-parse":
          return { stdout: Buffer.from(`${OID}\n`), code: 0 };
        default:
          throw new Error(`unexpected ${args.join(" ")}`);
      }
    },
  };
  return { git, calls };
}

function make(script: Script, over: { row?: Partial<LaneRow>; readOnly?: boolean } = {}) {
  const { git, calls } = fake(script);
  const locks = createLaneLocks(() => "lane-1");
  const refresh = vi.fn(async () => undefined);
  const publish = vi.fn();
  const notices: unknown[][] = [];
  const lane = { ...row, ...over.row } as LaneRow;
  const committer = createCommitter({
    store: { getOwned: (owner, id) => (owner === "u1" && id === "lane-1" ? lane : undefined) },
    git,
    gitDirOf: () => GIT_DIR,
    lock: locks.laneLock,
    refresh,
    publish,
    logger: silentLogger,
    readOnly: over.readOnly ?? false,
    notices: { add: (...args) => void notices.push(args) },
  });
  return { committer, calls, locks, refresh, publish, notices };
}
const commit = (m: ReturnType<typeof make>, paths: string[], message = "Add things") =>
  m.committer.commit(testCaller(), { laneId: "lane-1", paths, message });
const names = (calls: Call[]) => calls.map((call) => call.args[0]);

describe("lanes.commit", () => {
  it("stages the chosen paths on stdin and commits them with the trailer, from the lane root and the stored git dir", async () => {
    const m = make({ status: ordinary("a.txt") + untracked("new.txt") + ordinary("other.txt") });
    expect(await commit(m, ["a.txt", "new.txt"])).toEqual({ ok: true, oid: OID });
    const [, add, , , commitCall, revParse] = m.calls;
    expect(names(m.calls)).toEqual(["status", "add", "diff", "diff", "commit", "rev-parse"]);
    expect(add?.args).toEqual(["add", "--pathspec-from-file=-", "--pathspec-file-nul"]);
    expect(add?.options.input?.toString("utf8")).toBe("a.txt\0new.txt\0");
    expect(commitCall?.args).toEqual([
      "commit",
      "--file=-",
      "--no-gpg-sign",
      "--quiet",
      "--",
      "./a.txt",
      "./new.txt",
    ]);
    expect(commitCall?.options.input?.toString("utf8")).toBe("Add things\n\nPap-Lane: lane-1\n");
    expect(revParse?.args).toEqual(["rev-parse", "--verify", "HEAD"]);
    for (const call of m.calls) {
      expect(call.root).toBe("/wt/lane-1");
      expect(call.options.gitDir).toBe(GIT_DIR);
    }
    expect(add?.options.timeoutMs).toBe(60_000);
    expect(commitCall?.options).toMatchObject({ timeoutMs: 60_000, keepStderr: true });
    expect(m.refresh).toHaveBeenCalledWith("lane-1");
    expect(m.publish).toHaveBeenCalledWith("lane-1");
  });

  it("drops a gitlink from the staged list and from the commit", async () => {
    const m = make({ status: ordinary("a.txt") + gitlink("sub") });
    await commit(m, ["a.txt", "sub"]);
    expect(m.calls[1]?.options.input?.toString("utf8")).toBe("a.txt\0");
    expect(m.calls[4]?.args.slice(5)).toEqual(["./a.txt"]);
  });

  it("answers nothing_to_commit when the only chosen path is a gitlink", async () => {
    const m = make({ status: gitlink("sub") });
    expect(await commit(m, ["sub"])).toEqual({ ok: false, reason: "nothing_to_commit" });
    expect(names(m.calls)).toEqual(["status"]);
  });

  it("takes an embedded nested repository out of the index before the commit, names only what is left, and says so", async () => {
    const m = make({ status: untracked("vendor/") + untracked("src/"), embedded: ["vendor/"] });
    expect(await commit(m, ["vendor/", "src/"])).toEqual({ ok: true, oid: OID });
    expect(names(m.calls)).toEqual(["status", "add", "diff", "rm", "diff", "commit", "rev-parse"]);
    expect(m.calls[3]?.args).toEqual([
      "rm",
      "--cached",
      "-f",
      "--quiet",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ]);
    expect(m.calls[3]?.options.input?.toString("utf8")).toBe("vendor\0");
    expect(m.calls[5]?.args.slice(5)).toEqual(["./src/f.txt"]);
    expect(m.notices).toEqual([["lane-1", "nested_repo_left_out", 1]]);
  });

  it("answers nothing_to_commit, with the notice, when the only thing chosen is a nested repository", async () => {
    const m = make({ status: untracked("vendor/lib/"), embedded: ["vendor/lib/"] });
    expect(await commit(m, ["vendor/lib"])).toEqual({ ok: false, reason: "nothing_to_commit" });
    expect(names(m.calls)).toEqual(["status", "add", "diff", "rm", "diff"]);
    expect(m.notices).toEqual([["lane-1", "nested_repo_left_out", 1]]);
  });

  it("takes the changed files under a chosen folder, and a file inside an untracked folder", async () => {
    const m = make({ status: ordinary("src/a.ts") + ordinary("src/deep/b.ts") + untracked("docs/") });
    await commit(m, ["src", "docs/readme.md"]);
    expect(m.calls[1]?.options.input?.toString("utf8")).toBe("src/a.ts\0src/deep/b.ts\0docs/readme.md\0");
  });

  it("stages a deletion and the new name of a rename, and commits the old name too", async () => {
    const m = make({ status: deleted("gone.txt") + renamed("new.txt", "old.txt") });
    await commit(m, ["gone.txt", "new.txt"]);
    expect(m.calls[1]?.options.input?.toString("utf8")).toBe("gone.txt\0new.txt\0");
    expect(m.calls[4]?.args.slice(5)).toEqual(["./gone.txt", "./new.txt", "./old.txt"]);
  });

  it("starts a path that begins with a dash like any other", async () => {
    const m = make({ status: ordinary("-rf") });
    await commit(m, ["-rf"]);
    expect(m.calls[4]?.args.slice(5)).toEqual(["./-rf"]);
  });

  it("answers nothing_to_commit when no chosen path changed, without running add", async () => {
    const m = make({ status: ordinary("other.txt") });
    expect(await commit(m, ["a.txt"])).toEqual({ ok: false, reason: "nothing_to_commit" });
    expect(names(m.calls)).toEqual(["status"]);
  });

  it("answers conflicted for an unmerged chosen path, without running add", async () => {
    const m = make({ status: unmerged("c.txt") + ordinary("a.txt") });
    expect(await commit(m, ["c.txt", "a.txt"])).toEqual({ ok: false, reason: "conflicted" });
    expect(names(m.calls)).toEqual(["status"]);
  });

  it("classifies what git says", async () => {
    const cases: Array<[Script["commit"], string]> = [
      [{ code: 1, stdout: "On branch x\nnothing to commit, working tree clean\n" }, "nothing_to_commit"],
      [{ code: 1, stdout: "no changes added to commit\n" }, "nothing_to_commit"],
      [{ code: 128, stderr: "*** Please tell me who you are.\n" }, "identity_missing"],
      [
        { code: 128, stderr: "fatal: unable to auto-detect email address (got 'x@y.(none)')" },
        "identity_missing",
      ],
      [
        { code: 128, stderr: "error: Committing is not possible because you have unmerged files." },
        "conflicted",
      ],
      [{ code: 128, stderr: "fatal: cannot do a partial commit during a merge. conflict" }, "conflicted"],
      [{ code: 128, stderr: "fatal: something else" }, "failed"],
    ];
    for (const [commitAnswer, reason] of cases) {
      const m = make({ status: ordinary("a.txt"), commit: commitAnswer });
      expect(await commit(m, ["a.txt"]), JSON.stringify(commitAnswer)).toEqual({ ok: false, reason });
      expect(m.refresh).toHaveBeenCalled();
    }
  });

  it("classifies a failed add the same way", async () => {
    const m = make({ status: ordinary("a.txt"), add: { code: 128, stderr: "fatal: unmerged conflict" } });
    expect(await commit(m, ["a.txt"])).toEqual({ ok: false, reason: "conflicted" });
    expect(names(m.calls)).toEqual(["status", "add"]);
  });

  it("maps a git timeout to the timeout error and any other git failure to failed", async () => {
    const late = make({ status: ordinary("a.txt"), commit: new GitError("timeout") });
    await expect(commit(late, ["a.txt"])).rejects.toMatchObject({ code: "timeout" });
    const broken = make({ status: ordinary("a.txt"), add: new GitError("failed") });
    expect(await commit(broken, ["a.txt"])).toEqual({ ok: false, reason: "failed" });
  });

  it("refuses more paths than one staging list holds", async () => {
    const status = Array.from({ length: 4100 }, (_, at) => ordinary(`f${at}.txt`)).join("");
    const m = make({ status });
    const paths = Array.from({ length: 4100 }, (_, at) => `f${at}.txt`);
    expect(await commit(m, paths)).toEqual({ ok: false, reason: "failed" });
    expect(names(m.calls)).toEqual(["status"]);
  });

  it("is the caller's own lane, writable and active", async () => {
    const m = make({ status: ordinary("a.txt") });
    await expect(
      m.committer.commit(testCaller({ userId: "u2" }), { laneId: "lane-1", paths: ["a.txt"], message: "m" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(commit(make({}, { readOnly: true }), ["a.txt"])).rejects.toBeInstanceOf(PapError);
    expect(await commit(make({}, { row: { state: "archived" } }), ["a.txt"])).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("waits for the lane lock", async () => {
    const m = make({ status: ordinary("a.txt") });
    let release!: () => void;
    const held = m.locks
      .laneLock("lane-1")
      .run("restore", () => new Promise<void>((resolve) => (release = resolve)));
    const pending = commit(m, ["a.txt"]);
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(m.calls).toEqual([]);
    release();
    await held;
    expect(await pending).toEqual({ ok: true, oid: OID });
  });
});
