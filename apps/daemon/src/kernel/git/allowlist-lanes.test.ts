import { describe, expect, it } from "vitest";
import { prepare } from "./allowlist.ts";
import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "./exec.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const INDEX = "/home/x/tmp/git-index/idx-0123456789abcdef0123456789abcdef";
const split = (text: string): string[] =>
  text.split(" ").map((part) => part.replaceAll("<A>", A).replaceAll("<B>", B));

const REFUSED = [
  "merge-base --is-ancestor HEAD <A>",
  "merge-base --is-ancestor <A> <B>",
  "merge-base --is-ancestor <A> HEAD -- x",
  "merge-base --is-ancestor <A> HEAD extra",
  "merge-base --is-ancestor main HEAD",
  "merge-base --is-ancestor --all <A> HEAD",
  "merge-base --is-ancestor <A>",
  // the planner's list
  "gc",
  "push origin",
  "worktree add --force /p b",
  "worktree move /a /b",
  "restore --source=HEAD",
  "restore --source=<A>x --worktree --staged -- .",
  "branch -m a b",
  "commit -m x",
  "commit --file=/etc/passwd",
  // `clean` has no caller since Task 11 (M1 of the final review): a new one brings its own injection review.
  "clean -f -d -- .",
  "clean -f -d -x -- .",
  "clean -fdx -- .",
  "for-each-ref --format=%(contents) refs/heads",
  "add -A -- -rf",
  "remote add x y",
  "config core.fsmonitor x",
  "config --get remote.origin.pushurl",
  // the red-team's
  "commit --quiet -- ./x",
  "commit --file=- --no-gpg-sign ./x",
  "commit --file=- --no-gpg-sign --",
  "commit --file=- --no-gpg-sign -- x",
  "commit --file=- --no-gpg-sign -- --quiet ./x",
  "clean -f -d -- -f .",
  "clean -f -f -d -- .",
  "clean -f -d -- sub",
  "clean -f -- .",
  "reset --quiet <A>",
  "reset --quiet HEAD~5 -- .",
  "reset --quiet --hard",
  "reset --quiet -- ./x",
  "update-ref --no-deref refs/heads/main <A>",
  "update-ref --no-deref -d refs/heads/main",
  "update-ref refs/pap/checkpoints/fix-a-1a2b/root <A>",
  "update-ref -d refs/pap/checkpoints/fix-a-1a2b/undo",
  "update-ref --no-deref --no-deref refs/pap/checkpoints/fix-a-1a2b/root <A>",
  "update-ref refs/heads/main <A>",
  "update-ref -d refs/heads/main",
  "update-ref --no-deref refs/pap/checkpoints/../x/root <A>",
  "update-ref --no-deref refs/pap/checkpoints/fix-a-1a2b/e/a/b <A>",
  "update-ref --no-deref refs/pap/checkpoints/fix-a-1a2b/root HEAD",
  "update-ref --no-deref refs/pap/checkpoints/fix-a-1a2b/root <A> <B>",
  "update-ref --no-deref -d refs/pap/checkpoints/fix-a-1a2b/root <A>",
  // call shapes
  "branch -D a b",
  "branch --no-track main HEAD",
  "branch --no-track pi/x",
  "branch -d @",
  "branch -d -D a",
  "branch -D -- a",
  "worktree add --lock /p b",
  "worktree add --lock --reason=pap-creating rel/path b",
  "worktree add --lock --reason=pap-creating /p b c",
  "worktree add --lock --reason=other /p b",
  "worktree add --reason=pap-creating /p b",
  "worktree add --lock --reason=pap-creating /p @",
  "worktree remove /abs",
  "worktree remove --force --force /p",
  "worktree remove --force rel",
  "worktree remove --force",
  "worktree unlock rel",
  "worktree",
  "worktree --porcelain",
  "worktree list /p",
  "worktree prune --expire=now",
  "for-each-ref --format=%(refname) --format=%(refname) refs/heads",
  "for-each-ref --format=%(refname) HEAD",
  "for-each-ref --format=%(refname) --merged=main refs/heads",
  "for-each-ref --format=%(refname) --merged refs/heads",
  "for-each-ref --format=%(refname) --no-merged=HEAD refs/heads",
  "for-each-ref --format=%(refname) refs/heads -- refs/x",
  "for-each-ref --format=%(refname)",
  "commit-tree HEAD",
  "commit-tree <A> <B>",
  "commit-tree <A> -p <B> -p <A>",
  "commit-tree <A> -p HEAD",
  "read-tree <A>",
  "restore --source=<A> --source=<B> --worktree --staged -- .",
  "restore --source=<A> --worktree --staged -- x",
  "restore --source=<A> --worktree -- .",
  "restore --source=<A> --worktree --pathspec-from-file=-",
  "restore --source=<A> --worktree --pathspec-file-nul",
  "restore --source=<A> --worktree --staged --pathspec-from-file=- --pathspec-file-nul",
  "restore --source=<A> --worktree --pathspec-from-file=- --pathspec-file-nul -- .",
  "restore --source=<A> --worktree --pathspec-from-file=- --pathspec-file-nul x",
  "restore --worktree --pathspec-from-file=- --pathspec-file-nul",
  "restore --source=<A> --source=<B> --worktree --pathspec-from-file=- --pathspec-file-nul",
  "restore --source=<A> --worktree --pathspec-from-file=/etc/passwd --pathspec-file-nul",
  "restore --worktree --staged -- .",
  "restore --source=<A> --worktree --staged .",
  "add -A -u -- .",
  "add -A",
  "add -A -- .",
  "add -u -- .",
  "add -A -- ./-rf",
  "add -u -- ./a ./b",
  "add --pathspec-from-file=- --pathspec-file-nul --pathspec-from-file=-",
  "add --pathspec-from-file=- --pathspec-file-nul -A",
  "add --pathspec-file-nul",
  "add -A -- x",
  "add --pathspec-from-file=/etc/passwd --pathspec-file-nul",
  "add --pathspec-from-file=- --pathspec-file-nul -- .",
  "add --pathspec-from-file=- -- .",
  "rm --cached -f --quiet",
  "rm -rf --quiet --pathspec-from-file=- --pathspec-file-nul",
  "rm -f --quiet --pathspec-from-file=- --pathspec-file-nul",
  "rm --cached -f --quiet --pathspec-from-file=/etc/passwd --pathspec-file-nul",
  "rm --cached -f --quiet --pathspec-from-file=- --pathspec-file-nul -- x",
  "rm --cached -f --quiet --pathspec-from-file=- --pathspec-file-nul -r",
  "check-ref-format x",
  "check-ref-format --branch a b",
  "check-ref-format --branch",
];

const ACCEPTED = [
  "restore --source=<A> --worktree --pathspec-from-file=- --pathspec-file-nul",
  "restore --source=<A> --worktree --staged -- .",
  "reset --quiet -- .",
  "add --pathspec-from-file=- --pathspec-file-nul",
  "rm --cached -f --quiet --pathspec-from-file=- --pathspec-file-nul",
  "diff --cached --raw -z --no-abbrev --ignore-submodules=dirty",
  "diff --raw -z --no-abbrev --no-renames --ignore-submodules=dirty",
  "commit --file=- --no-gpg-sign --quiet -- ./x ./-y",
  "commit --file=- --no-gpg-sign -- ./x",
  "branch --no-track pi/fix-412-high-memory <A>",
  "branch -D pi/x",
  "branch -d pi/x",
  "worktree add --lock --reason=pap-creating /abs pi/x",
  "worktree unlock /abs",
  "worktree remove --force /abs",
  "worktree prune",
  "worktree list --porcelain -z",
  "update-ref --no-deref refs/pap/checkpoints/fix-a-1a2b/e/L1 <A>",
  "update-ref --no-deref refs/pap/checkpoints/fix-a-1a2b/root <A>",
  "update-ref --no-deref -d refs/pap/checkpoints/fix-a-1a2b/undo",
  "commit-tree <A> -p <B>",
  "commit-tree <A>",
  "check-ref-format --branch @",
  "for-each-ref --format=%(refname) --sort=-committerdate --count=500 refs/heads refs/remotes",
  "for-each-ref --format=%(refname) --merged=HEAD --sort=-committerdate --count=500 refs/heads refs/remotes",
  "rev-parse --git-path index",
  "rev-parse --verify --quiet <A>",
  "rev-list --count --left-right a...b",
  "merge-base a b",
  "merge-base --is-ancestor <A> HEAD",
  "diff --raw -M --no-abbrev --no-color -U3 -z HEAD --",
];

describe("lane allowlist: refusals (M9R9)", () => {
  it.each(REFUSED)("refuses %s", (text) => {
    expect(prepare(split(text), "local", { GIT_INDEX_FILE: INDEX })).toBeNull();
  });
});

describe("lane allowlist: accepted calls", () => {
  it.each(ACCEPTED)("accepts %s", (text) => {
    expect(prepare(split(text), "local")).not.toBeNull();
  });

  it("accepts read-tree HEAD and read-tree --empty only with a temporary index", () => {
    expect(prepare(["read-tree", "HEAD"], "local")).toBeNull();
    expect(prepare(["read-tree", "--empty"], "local")).toBeNull();
    expect(prepare(["read-tree", "HEAD"], "local", { GIT_INDEX_FILE: INDEX })).toEqual(["read-tree", "HEAD"]);
    expect(prepare(["read-tree", "--empty"], "local", { GIT_INDEX_FILE: INDEX })).toEqual([
      "read-tree",
      "--empty",
    ]);
    expect(prepare(["read-tree", "--empty", "HEAD"], "local", { GIT_INDEX_FILE: INDEX })).toBeNull();
    expect(prepare(["read-tree", A], "local", { GIT_INDEX_FILE: INDEX })).toBeNull();
  });

  it("accepts write-tree only with a temporary index (M9 T11-14)", () => {
    expect(prepare(["write-tree"], "local")).toBeNull();
    expect(prepare(["write-tree"], "local", { GIT_INDEX_FILE: INDEX })).toEqual(["write-tree"]);
  });

  it("still inserts the runner's own options after a lane diff", () => {
    expect(prepare(split("diff --raw -z HEAD --"), "local")).toEqual([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--raw",
      "-z",
      "HEAD",
      "--",
    ]);
  });

  it("keeps M8's runner callers unchanged", () => {
    expect(
      prepare(
        split("diff --numstat -z --ignore-submodules=dirty --no-ext-diff --no-textconv HEAD --"),
        "local",
      ),
    ).toEqual(
      split(
        "diff --no-ext-diff --no-textconv --numstat -z --ignore-submodules=dirty --no-ext-diff --no-textconv HEAD --",
      ),
    );
  });
});

// Task 2b: the remote half. `push` runs only under the remote profile, every other call only under the local one.
const PUSH = "push --porcelain --set-upstream origin";
const BRANCH_SPEC = "refs/heads/pi/fix-1:refs/heads/pi/fix-1";
const REMOTE_REFUSED = [
  `${PUSH} :refs/heads/main`,
  `${PUSH} +refs/heads/a:refs/heads/a`,
  `${PUSH} refs/heads/a:refs/heads/main`,
  `${PUSH} ${BRANCH_SPEC} refs/heads/b:refs/heads/b`,
  `push --porcelain --set-upstream evil ${BRANCH_SPEC}`,
  `push --porcelain origin ${BRANCH_SPEC}`,
  `push --set-upstream origin ${BRANCH_SPEC}`,
  `${PUSH} --force ${BRANCH_SPEC}`,
  `${PUSH} -f ${BRANCH_SPEC}`,
  `${PUSH} --force-with-lease ${BRANCH_SPEC}`,
  `${PUSH} --tags ${BRANCH_SPEC}`,
  `${PUSH} --receive-pack=/bin/evil ${BRANCH_SPEC}`,
  `${PUSH} refs/heads/x.lock:refs/heads/x.lock`,
  `${PUSH} refs/tags/v1:refs/tags/v1`,
  `${PUSH} refs/heads/a:refs/heads/a --delete`,
  `${PUSH} -- ${BRANCH_SPEC}`,
  `push --porcelain --set-upstream https://evil.example/x ${BRANCH_SPEC}`,
  "remote get-url --push --all origin",
  "status --porcelain=v2",
];

describe("remote allowlist (M9R10, M9R14)", () => {
  it.each(REMOTE_REFUSED)("refuses %s under remote", (text) => {
    expect(prepare(split(text), "remote")).toBeNull();
  });

  it(`accepts ${PUSH} <branch>:<branch> under remote only`, () => {
    expect(prepare(split(`${PUSH} ${BRANCH_SPEC}`), "remote")).not.toBeNull();
    expect(prepare(split(`${PUSH} ${BRANCH_SPEC}`), "local")).toBeNull();
  });

  it.each([
    ["config", ORIGIN_URLS_ARGS],
    ["push scan", PUSH_SCAN_ARGS],
  ])("the %s read runs under local only", (_name, args) => {
    expect(prepare([...args], "local")).toEqual([...args]);
    expect(prepare([...args], "remote")).toBeNull();
  });

  it.each([
    "remote get-url --push origin",
    "remote get-url --push --all upstream",
    "remote get-url --all origin",
    "remote get-url --push --all origin extra",
    "remote get-url --push --all -- origin",
    "remote add x y",
    "remote set-url origin https://evil/x",
    "remote",
    "config --get remote.origin.url",
    "config --get-all remote.origin.pushurl",
  ])("refuses %s", (text) => {
    expect(prepare(split(text), "local")).toBeNull();
  });

  it("accepts remote get-url --push --all origin under local only", () => {
    expect(prepare(split("remote get-url --push --all origin"), "local")).not.toBeNull();
  });
});
