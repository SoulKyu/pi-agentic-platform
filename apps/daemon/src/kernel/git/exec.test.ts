import { describe, expect, it } from "vitest";
import { gitArgs, gitEnv } from "./exec.ts";

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
      "log.diffMerges=separate",
      "-c",
      "core.alternateRefsCommand=",
      "-c",
      "diff.submodule=short",
      "-c",
      "safe.bareRepository=explicit",
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

describe("gitArgs for check-ignore (MC15)", () => {
  it("drops --literal-pathspecs for check-ignore only: it exits 128 under it, with stdin and with paths", () => {
    expect(gitArgs("/r", ["check-ignore", "-z", "--stdin"])).not.toContain("--literal-pathspecs");
    expect(gitArgs("/r", ["check-ignore", "./a"])).not.toContain("--literal-pathspecs");
    for (const subcommand of ["status", "ls-files", "diff", "cat-file", "check-ignorex"]) {
      expect(gitArgs("/r", [subcommand]), subcommand).toContain("--literal-pathspecs");
    }
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
      GIT_CEILING_DIRECTORIES: "/srv",
    });
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
