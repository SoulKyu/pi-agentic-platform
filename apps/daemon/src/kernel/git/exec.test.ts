import { describe, expect, it } from "vitest";
import { KEPT, gitArgs, gitEnv, isLaneGitDir } from "./exec.ts";
import { isNeverPassedEnvKey } from "@pap/contracts";

describe("gitArgs", () => {
  it("puts the fixed flags and the switched-off config before -C <root> and the subcommand", () => {
    expect(gitArgs("/r", ["status"])).toEqual([
      "--no-optional-locks",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.pager=cat",
      "-c",
      "diff.external=",
      "-c",
      "protocol.allow=never",
      "-c",
      "credential.helper=",
      "-c",
      "log.showSignature=false",
      "-c",
      "gpg.program=",
      "-c",
      "gpg.x509.program=",
      "-c",
      "gpg.ssh.program=",
      "-c",
      "gpg.ssh.defaultKeyCommand=",
      "-c",
      "log.diffMerges=separate",
      "-c",
      "core.alternateRefsCommand=",
      "-c",
      "diff.submodule=short",
      "-c",
      "safe.bareRepository=explicit",
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "-c",
      "submodule.recurse=false",
      "-C",
      "/r",
      "status",
    ]);
  });

  it("passes the caller's arguments after the root, untouched", () => {
    expect(gitArgs("/r", ["cat-file", "blob", "HEAD:-rf"]).slice(-5)).toEqual([
      "-C",
      "/r",
      "cat-file",
      "blob",
      "HEAD:-rf",
    ]);
  });
});

describe("gitArgs work-tree pin (M9R10)", () => {
  it("pins --work-tree=<root> right after -C <root> for the subcommands that write the work tree or the index", () => {
    const args = gitArgs("/r", ["clean", "-f", "-d", "--", "."]);
    const at = args.indexOf("-C");
    expect(args.slice(at, at + 4)).toEqual(["-C", "/r", "--work-tree=/r", "clean"]);
    for (const subcommand of ["add", "commit", "restore", "reset"])
      expect(gitArgs("/r", [subcommand]), subcommand).toContain("--work-tree=/r");
  });

  it("leaves reads and ref calls alone", () => {
    for (const subcommand of ["status", "diff", "worktree", "branch", "update-ref", "read-tree", "rev-parse"])
      expect(
        gitArgs("/r", [subcommand]).some((arg) => arg.startsWith("--work-tree")),
        subcommand,
      ).toBe(false);
  });
});

describe("gitArgs git-dir pin (MC1 I4)", () => {
  const GIT_DIR = "/m/.git/worktrees/lane";
  it("pins --git-dir then --work-tree right after -C <root>", () => {
    const args = gitArgs("/r", ["restore", "--worktree"], GIT_DIR);
    const at = args.indexOf("-C");
    expect(args.slice(at, at + 5)).toEqual(["-C", "/r", `--git-dir=${GIT_DIR}`, "--work-tree=/r", "restore"]);
  });
  it("pins the git dir and the work tree of a read too (MC3 I2)", () => {
    const args = gitArgs("/r", ["status"], GIT_DIR);
    expect(args).toContain(`--git-dir=${GIT_DIR}`);
    expect(args).toContain("--work-tree=/r");
  });
  it("adds nothing without a git dir", () => {
    expect(gitArgs("/r", ["status"]).some((arg) => arg.startsWith("--git-dir"))).toBe(false);
  });
});

describe("isLaneGitDir", () => {
  it("accepts <common>/worktrees/<name> as an absolute, normal path", () => {
    expect(isLaneGitDir("/m/.git/worktrees/lane")).toBe(true);
    expect(isLaneGitDir("/a b/.git/worktrees/x-1")).toBe(true);
  });
  it.each([
    "",
    "relative/.git/worktrees/l",
    "/m/.git",
    "/m/.git/worktrees",
    "/m/.git/worktrees/",
    "/m/.git/worktrees/a/b",
    "/m/../.git/worktrees/l",
    "/m/./.git/worktrees/l",
    "/m/.git/worktrees/..",
    "/m/.git/worktrees/.",
    "/m/.git/worktrees/l\0x",
    "/m//.git/worktrees/l",
    "--git-dir=/x/worktrees/l",
  ])("refuses %j", (path) => {
    expect(isLaneGitDir(path)).toBe(false);
  });
});

describe("gitArgs for check-ignore (MC15)", () => {
  it("drops --literal-pathspecs for check-ignore only: it exits 128 under it, with stdin and with paths", () => {
    expect(gitArgs("/r", ["check-ignore", "-z", "--stdin"])).not.toContain("--literal-pathspecs");
    expect(gitArgs("/r", ["check-ignore", "./a"])).not.toContain("--literal-pathspecs");
    for (const subcommand of ["status", "ls-files", "diff", "cat-file", "check-ignorex"]) {
      expect(gitArgs("/r", [subcommand]), subcommand).toContain("--literal-pathspecs");
    }
  });
});

describe("gitEnv PATH (M2)", () => {
  it("drops relative entries, empty ones included, and keeps the absolute ones in order", () => {
    expect(gitEnv({ PATH: "./node_modules/.bin:/usr/local/bin::.:/usr/bin:bin" }, "/srv/p").PATH).toBe(
      "/usr/local/bin:/usr/bin",
    );
  });
  it("leaves a missing PATH missing", () => {
    expect(gitEnv({}, "/srv/p").PATH).toBeUndefined();
  });
});

describe("gitEnv", () => {
  it("keeps an allowlist and adds the fixed variables and a ceiling at the root's parent", () => {
    const base = {
      PATH: "/bin",
      HOME: "/h",
      GIT_DIR: "/x",
      GIT_EXTERNAL_DIFF: "evil",
      LD_PRELOAD: "/l.so",
      PAP_X: "1",
      NODE_OPTIONS: "--x",
      GIT_CEILING_DIRECTORIES: "/",
    };
    expect(gitEnv(base, "/srv/p")).toEqual({
      PATH: "/bin",
      HOME: "/h",
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EDITOR: ":",
      GIT_SEQUENCE_EDITOR: ":",
      GIT_CEILING_DIRECTORIES: "/srv",
    });
  });

  it("keeps no name the unattended children never get (M9R103)", () => {
    expect(KEPT.filter((name) => isNeverPassedEnvKey(name))).toEqual([]);
  });

  it("carries the other allowlisted variables when the daemon has them", () => {
    const env = gitEnv(
      { USER: "u", LOGNAME: "l", LANG: "C.UTF-8", TMPDIR: "/t", XDG_CONFIG_HOME: "/c", LC_ALL: "fr_FR" },
      "/a/b",
    );
    expect(env).toMatchObject({
      USER: "u",
      LOGNAME: "l",
      LANG: "C.UTF-8",
      TMPDIR: "/t",
      XDG_CONFIG_HOME: "/c",
      LC_ALL: "C",
      GIT_CEILING_DIRECTORIES: "/a",
    });
  });
});
