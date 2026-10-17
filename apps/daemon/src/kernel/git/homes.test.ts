import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { prepare } from "./allowlist.ts";
import { isAgentGitDir } from "./exec.ts";
import { guardFilters } from "./filters.ts";
import { createGitRunner } from "./runner.ts";

const INIT = ["init", "--initial-branch=main", "--template="];
const GIT_DIR = "/h/pap/agents/atlas-1a2b/.git";

describe("init, the home's one new subcommand (M11R46)", () => {
  it("accepts exactly the template-less init on main, under the local profile", () => {
    expect(prepare(INIT, "local")).toEqual(INIT);
    expect(prepare(INIT, "remote")).toBeNull();
  });

  it.each([
    [["init"]],
    [["init", "--initial-branch=main"]],
    [["init", "--template="]],
    [["init", "--initial-branch=trunk", "--template="]],
    [["init", "--initial-branch=main", "--template=/tmp/hooks"]],
    [["init", "--initial-branch=main", "--template=", "/elsewhere"]],
    [["init", "--initial-branch=main", "--template=", "--bare"]],
    [["init", "-b", "main", "--template="]],
  ])("refuses %j", (args) => {
    expect(prepare(args, "local")).toBeNull();
  });
});

describe("isAgentGitDir", () => {
  it("accepts <anything>/agents/<agent id>/.git, absolute and normal", () => {
    expect(isAgentGitDir(GIT_DIR)).toBe(true);
    expect(isAgentGitDir("/agents/a-0000/.git")).toBe(true);
  });

  it.each([
    "",
    "agents/atlas-1a2b/.git",
    "/h/pap/agents/atlas/.git",
    "/h/pap/agents/.runs/.git",
    "/h/pap/agents/.trash/.git",
    "/h/pap/agents/atlas-1a2b",
    "/h/pap/agents/atlas-1a2b/.git/x",
    "/h/pap/agents/atlas-1a2b/.gitx",
    "/h/pap/agent/atlas-1a2b/.git",
    "/h/pap/agents/../agents/atlas-1a2b/.git",
    "/h/pap/agents/./atlas-1a2b/.git",
    "/h/pap//agents/atlas-1a2b/.git",
    "/h/pap/agents/atlas-1a2b/.git\0",
    "--git-dir=/h/pap/agents/atlas-1a2b/.git",
  ])("refuses %j", (path) => {
    expect(isAgentGitDir(path)).toBe(false);
  });
});

describe("the runner and a home's git dir", () => {
  function bed() {
    const seen: string[][] = [];
    const runner = createGitRunner({
      env: { PATH: "/bin", HOME: "/h" },
      logger: captureLogger().logger,
      exec: async (_file, args) => {
        seen.push(args);
        return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
      },
    });
    return { runner, seen };
  }

  it("pins the home's git dir and work tree for a commit, and keeps hooks off", async () => {
    const { runner, seen } = bed();
    await runner.run(
      "/h/pap/agents/atlas-1a2b",
      ["commit", "--file=-", "--no-gpg-sign", "--", "./MEMORY.md"],
      {
        gitDir: GIT_DIR,
        input: Buffer.from("m\n"),
      },
    );
    expect(seen[0]).toEqual(
      expect.arrayContaining([`--git-dir=${GIT_DIR}`, "--work-tree=/h/pap/agents/atlas-1a2b"]),
    );
    expect(seen[0]).toEqual(expect.arrayContaining(["-c", "core.hooksPath=/dev/null"]));
  });

  it("still refuses a git dir that is neither a lane's nor an agent's", async () => {
    for (const gitDir of ["/h/pap/agents/atlas/.git", "/h/pap/.git", "/h/pap/agents/.runs/.git"]) {
      const { runner, seen } = bed();
      await expect(runner.run("/r", ["status"], { gitDir })).rejects.toMatchObject({ kind: "failed" });
      expect(seen).toHaveLength(0);
    }
  });

  it("accepts an agent git dir for add and commit only, and only with its own home as the root", async () => {
    const { runner, seen } = bed();
    const home = "/h/pap/agents/atlas-1a2b";
    await runner.run(home, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      gitDir: GIT_DIR,
      input: Buffer.from("./MEMORY.md\0"),
    });
    expect(seen).toHaveLength(1);
    for (const args of [
      ["status"],
      ["log"],
      ["diff"],
      ["reset", "--hard"],
      ["config", "--list"],
      ["config", "core.hooksPath", "x"],
    ]) {
      await expect(runner.run(home, args, { gitDir: GIT_DIR }), args[0]).rejects.toMatchObject({
        kind: "failed",
      });
    }
    for (const root of [
      "/h/pap/agents/other-0000",
      "/h/pap/agents",
      "/",
      "/h/pap/agents/atlas-1a2b/prompts",
    ]) {
      await expect(
        runner.run(root, ["commit", "--file=-", "--no-gpg-sign", "--", "./MEMORY.md"], {
          gitDir: GIT_DIR,
          input: Buffer.from("m\n"),
        }),
        root,
      ).rejects.toMatchObject({ kind: "failed" });
    }
    expect(seen).toHaveLength(1);
  });

  it("lets the filter guard scan the home's config before add and commit", async () => {
    const { runner, seen } = bed();
    const guarded = guardFilters(runner, { gitVersion: async () => "git version 2.50.0" });
    const home = "/h/pap/agents/atlas-1a2b";
    await guarded.run(home, ["add", "--pathspec-from-file=-", "--pathspec-file-nul"], {
      gitDir: GIT_DIR,
      input: Buffer.from("./MEMORY.md\0"),
    });
    expect(seen.map((args) => args.find((arg) => ["config", "add"].includes(arg)))).toEqual([
      "config",
      "add",
    ]);
  });

  it("runs init with no git dir", async () => {
    const { runner, seen } = bed();
    await runner.run("/h/pap/agents/atlas-1a2b", INIT);
    expect(seen[0]?.slice(-3)).toEqual(INIT);
  });
});
