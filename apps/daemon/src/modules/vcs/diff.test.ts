import { linkSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DiffSide, PapError } from "@pap/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitError } from "../../kernel/git/runner.ts";
import { readDiff } from "./diff.ts";
import { createVcsBed, fakeGit, type FakeAnswer, type VcsBed } from "./testing/vcs-bed.ts";

let bed: VcsBed;
beforeEach(() => {
  bed = createVcsBed();
});
afterEach(() => bed.dispose());

const OID = "0123456789abcdef0123456789abcdef01234567";
const worktree: DiffSide = { kind: "worktree" };
const head: DiffSide = { kind: "head" };
const index: DiffSide = { kind: "index" };
const commit: DiffSide = { kind: "commit", oid: OID };
const LIMIT = 400 * 1024;

function diff(
  request: { path: string; oldPath?: string; from: DiffSide; to: DiffSide },
  options: {
    git?: (args: readonly string[]) => FakeAnswer;
    root?: string;
    caller?: "session" | "token";
  } = {},
) {
  const { git, calls } = fakeGit(options.git ?? (() => ({ stdout: "", code: 128 })));
  const root = options.root ?? bed.repo;
  const run = readDiff(
    { git, deny: bed.deny, logger: bed.logger },
    bed.scope([root], options.caller ?? "session"),
    root,
    request,
  );
  return { run, calls };
}
const refused = async (run: Promise<unknown>) => ((await run.catch((e: unknown) => e)) as PapError).code;

describe("each side reads its own source", () => {
  it("asks git for the index as stage 0, for head, and for a commit by its oid", async () => {
    const { run, calls } = diff(
      { path: "a.txt", from: index, to: commit },
      { git: (args) => `text of ${args[2]}` },
    );
    expect(await run).toEqual({
      before: "text of :0:a.txt",
      after: `text of ${OID}:a.txt`,
      binary: false,
      truncated: false,
    });
    expect(calls).toEqual([
      ["cat-file", "blob", ":0:a.txt"],
      ["cat-file", "blob", `${OID}:a.txt`],
    ]);
    const second = diff({ path: "a.txt", from: head, to: head }, { git: () => "same" });
    await second.run;
    expect(second.calls).toEqual([
      ["cat-file", "blob", "HEAD:a.txt"],
      ["cat-file", "blob", "HEAD:a.txt"],
    ]);
  });

  it("reads the worktree side from the file through the boundary, git not involved", async () => {
    const { run, calls } = diff({ path: "a.txt", from: head, to: worktree }, { git: () => "zero\n" });
    expect(await run).toEqual({ before: "zero\n", after: "one\n", binary: false, truncated: false });
    expect(calls).toEqual([["cat-file", "blob", "HEAD:a.txt"]]);
  });

  it("takes the old path for the from side and the path for the to side of a rename", async () => {
    writeFileSync(join(bed.repo, "d.txt"), "renamed\n");
    const { run, calls } = diff(
      { path: "d.txt", oldPath: "a.txt", from: head, to: worktree },
      { git: () => "old\n" },
    );
    expect(await run).toEqual({ before: "old\n", after: "renamed\n", binary: false, truncated: false });
    expect(calls).toEqual([["cat-file", "blob", "HEAD:a.txt"]]);
  });

  it("gives a missing blob or a missing file a null side", async () => {
    const missingBlob = diff({ path: "a.txt", from: head, to: worktree });
    expect(await missingBlob.run).toEqual({ before: null, after: "one\n", binary: false, truncated: false });
    const missingFile = diff({ path: "nope.txt", from: head, to: worktree }, { git: () => "x" });
    expect(await missingFile.run).toEqual({ before: "x", after: null, binary: false, truncated: false });
  });
});

describe("binary and large sides", () => {
  it("calls a NUL in the first 8 KiB of either side binary and returns neither", async () => {
    const nul = Buffer.concat([Buffer.from("abc"), Buffer.from([0]), Buffer.from("d")]);
    const blob = diff({ path: "a.txt", from: head, to: worktree }, { git: () => nul });
    expect(await blob.run).toEqual({ before: null, after: null, binary: true, truncated: false });
    writeFileSync(join(bed.repo, "bin.dat"), nul);
    const file = diff({ path: "bin.dat", from: head, to: worktree }, { git: () => "text" });
    expect(await file.run).toEqual({ before: null, after: null, binary: true, truncated: false });
  });

  it("does not look for a NUL past the first 8 KiB", async () => {
    const late = Buffer.concat([Buffer.alloc(8 * 1024, 0x61), Buffer.from([0])]);
    const { run } = diff({ path: "a.txt", from: head, to: worktree }, { git: () => late });
    expect(await run).toMatchObject({ binary: false, truncated: false });
  });

  it("marks a side over 400 KiB truncated with both sides null, and takes exactly 400 KiB", async () => {
    const big = Buffer.alloc(LIMIT + 1, 0x61);
    const blob = diff({ path: "a.txt", from: head, to: worktree }, { git: () => big });
    expect(await blob.run).toEqual({ before: null, after: null, binary: false, truncated: true });
    writeFileSync(join(bed.repo, "big.txt"), big);
    const file = diff({ path: "big.txt", from: head, to: worktree }, { git: () => "small" });
    expect(await file.run).toEqual({ before: null, after: null, binary: false, truncated: true });
    const edge = diff({ path: "a.txt", from: head, to: head }, { git: () => Buffer.alloc(LIMIT, 0x61) });
    expect(await edge.run).toMatchObject({ binary: false, truncated: false, before: "a".repeat(LIMIT) });
  });

  it("treats git's too_large as a truncated side", async () => {
    const { run } = diff(
      { path: "a.txt", from: head, to: worktree },
      { git: () => new GitError("too_large") },
    );
    expect(await run).toEqual({ before: null, after: null, binary: false, truncated: true });
  });

  it("fits the answer under 900 000 bytes: two sides that escape to more than that are truncated", async () => {
    const quotes = '"'.repeat(LIMIT);
    const { run } = diff({ path: "a.txt", from: head, to: head }, { git: () => quotes });
    expect(await run).toEqual({ before: null, after: null, binary: false, truncated: true });
  });
});

describe("what the boundary refuses answers not_found before git runs", () => {
  it("refuses a worktree link that leaves the root", async () => {
    symlinkSync(join(bed.bb.outside, "secret.txt"), join(bed.repo, "out"));
    const { run, calls } = diff({ path: "out", from: worktree, to: worktree });
    expect(await refused(run)).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("refuses a hard link to pap's database inside the root: the descriptor is checked, not only the name", async () => {
    linkSync(join(bed.bb.papHome, "state.db"), join(bed.repo, "linked.db"));
    const { run, calls } = diff({ path: "linked.db", from: worktree, to: worktree });
    expect(await refused(run)).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("refuses a folder as the worktree side", async () => {
    mkdirSync(join(bed.repo, "folder"));
    expect(await refused(diff({ path: "folder", from: worktree, to: worktree }).run)).toBe("not_found");
  });

  it("refuses a blob of a path that joins to $PAP_HOME in a repository rooted above it", async () => {
    for (const side of [head, index, commit, worktree]) {
      const { run, calls } = diff({ path: ".pap/state.db", from: side, to: worktree }, { root: bed.bb.home });
      expect(await refused(run), side.kind).toBe("not_found");
      expect(calls, side.kind).toEqual([]);
    }
    const { run, calls } = diff(
      { path: "x", oldPath: ".pap/state.db", from: head, to: head },
      { root: bed.bb.home },
    );
    expect(await refused(run)).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("refuses Pi's private files for the owner too", async () => {
    const { run, calls } = diff({ path: ".pi/agent/auth.json", from: head, to: head }, { root: bed.bb.home });
    expect(await refused(run)).toBe("not_found");
    expect(calls).toEqual([]);
  });

  it("refuses a token the head of .pi/mcp.json and of .mcp.json, and lets the owner read them", async () => {
    for (const path of [".pi/mcp.json", ".mcp.json"]) {
      const { run, calls } = diff({ path, from: head, to: head }, { root: bed.bb.proj, caller: "token" });
      expect(await refused(run), path).toBe("not_found");
      expect(calls, path).toEqual([]);
    }
    const owner = diff({ path: ".mcp.json", from: head, to: head }, { root: bed.bb.proj, git: () => "{}" });
    expect(await owner.run).toMatchObject({ before: "{}" });
  });
});

describe("git's failures", () => {
  it("answers timeout as the typed timeout error and lets a queue overflow through as capacity", async () => {
    expect(
      await refused(
        diff({ path: "a.txt", from: head, to: head }, { git: () => new GitError("timeout") }).run,
      ),
    ).toBe("timeout");
    expect(
      await refused(
        diff({ path: "a.txt", from: head, to: head }, { git: () => new PapError("capacity") }).run,
      ),
    ).toBe("capacity");
  });

  it("does not turn a failed or missing git into a null side", async () => {
    const error = await diff(
      { path: "a.txt", from: head, to: head },
      { git: () => new GitError("git_missing") },
    ).run.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
  });
});

describe("the index and commit sides on real git, including colons in names", () => {
  it("reads index, commit and head blobs of a path with a colon or a stage-like name", async () => {
    const names = ["a:b", "0:x", "dir/c:d.txt"];
    for (const name of names) {
      mkdirSync(join(bed.repo, name, ".."), { recursive: true });
      writeFileSync(join(bed.repo, name), "v1\n");
    }
    bed.gb.git(bed.repo, "add", ".");
    bed.gb.git(bed.repo, "commit", "-q", "-m", "colons");
    const oid = bed.gb.git(bed.repo, "rev-parse", "HEAD").trim();
    for (const name of names) writeFileSync(join(bed.repo, name), "v2\n");
    bed.gb.git(bed.repo, "add", ".");
    for (const name of names) writeFileSync(join(bed.repo, name), "v3\n");
    const env = { git: bed.git, deny: bed.deny, logger: bed.logger };
    const read = (path: string, from: DiffSide, to: DiffSide) =>
      readDiff(env, bed.scope([bed.repo]), bed.repo, { path, from, to });
    const commitSide: DiffSide = { kind: "commit", oid };
    for (const name of names) {
      const answers = await Promise.all([
        read(name, commitSide, index),
        read(name, index, worktree),
        read(name, head, index),
      ]);
      expect(
        answers.map((a) => [a.before, a.after]),
        name,
      ).toEqual([
        ["v1\n", "v2\n"],
        ["v2\n", "v3\n"],
        ["v1\n", "v2\n"],
      ]);
    }
    expect(await read("missing:file", index, commitSide)).toEqual({
      before: null,
      after: null,
      binary: false,
      truncated: false,
    });
  });
});
