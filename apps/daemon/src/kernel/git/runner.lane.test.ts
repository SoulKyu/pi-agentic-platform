import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createGitRunner } from "./runner.ts";
import { MAX_STAGE_BYTES, MAX_STAGE_PATHS, stageInput } from "./stage.ts";

const GIT_DIR = "/m/.git/worktrees/lane";
const STAGE = ["add", "--pathspec-from-file=-", "--pathspec-file-nul"];

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

describe("the git dir of a lane call (MC1 I4)", () => {
  it.each([
    ["restore", ["restore", "--source=" + "a".repeat(40), "--worktree", "--staged", "--", "."]],
    ["commit", ["commit", "--file=-", "--no-gpg-sign", "--", "./a"]],
    ["reset", ["reset", "--quiet", "--", "."]],
    ["clean", ["clean", "-f", "-d", "--", "."]],
    ["add", [...STAGE]],
  ])("refuses %s without a git dir, before git starts", async (_name, args) => {
    const { runner, seen } = bed();
    await expect(runner.run("/r", args, { input: Buffer.from("a\0") })).rejects.toMatchObject({
      kind: "failed",
    });
    expect(seen).toHaveLength(0);
  });

  it("passes --git-dir and --work-tree to a destructive call", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", ["reset", "--quiet", "--", "."], { gitDir: GIT_DIR });
    expect(seen[0]).toContain(`--git-dir=${GIT_DIR}`);
    expect(seen[0]).toContain("--work-tree=/r");
  });

  it.each(["", "relative/worktrees/x", "/m/.git", "/m/.git/worktrees/../x", "/m/.git/worktrees/a/b"])(
    "refuses the git dir %j",
    async (gitDir) => {
      const { runner, seen } = bed();
      await expect(runner.run("/r", ["status"], { gitDir })).rejects.toMatchObject({ kind: "failed" });
      expect(seen).toHaveLength(0);
    },
  );
});

describe("staging an explicit list (MC1 I3)", () => {
  it("takes the paths on stdin, NUL separated", async () => {
    const { runner, seen } = bed();
    const input = stageInput(["a.txt", "-rf", "dir/b c"]);
    expect(input?.toString("utf8")).toBe("a.txt\0-rf\0dir/b c\0");
    await runner.run("/r", STAGE, { gitDir: GIT_DIR, input: input ?? Buffer.alloc(0) });
    expect(seen[0]).toContain("--literal-pathspecs");
  });

  it("refuses a list that is missing, empty, unterminated or has an empty entry", async () => {
    const { runner, seen } = bed();
    for (const input of [
      undefined,
      Buffer.alloc(0),
      Buffer.from("a"),
      Buffer.from("a\0\0b\0"),
      Buffer.from("\0"),
    ])
      await expect(runner.run("/r", STAGE, { gitDir: GIT_DIR, input })).rejects.toMatchObject({
        kind: "failed",
      });
    expect(seen).toHaveLength(0);
  });

  it("refuses more than the path cap, and more than the byte cap", async () => {
    const { runner, seen } = bed();
    const many = Buffer.from("a\0".repeat(MAX_STAGE_PATHS + 1));
    const big = Buffer.from(`${"a".repeat(MAX_STAGE_BYTES)}\0`);
    for (const input of [many, big])
      await expect(runner.run("/r", STAGE, { gitDir: GIT_DIR, input })).rejects.toMatchObject({
        kind: "failed",
      });
    expect(seen).toHaveLength(0);
    await runner.run("/r", STAGE, { gitDir: GIT_DIR, input: Buffer.from("a\0".repeat(MAX_STAGE_PATHS)) });
    expect(seen).toHaveLength(1);
  });

  it("holds a listed restore to the same list caps", async () => {
    const { runner, seen } = bed();
    const args = [
      "restore",
      `--source=${"a".repeat(40)}`,
      "--worktree",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ];
    for (const input of [undefined, Buffer.from("a"), Buffer.from("a\0".repeat(MAX_STAGE_PATHS + 1))])
      await expect(runner.run("/r", args, { gitDir: GIT_DIR, input })).rejects.toMatchObject({
        kind: "failed",
      });
    expect(seen).toHaveLength(0);
    await runner.run("/r", args, { gitDir: GIT_DIR, input: Buffer.from("a\0") });
    expect(seen).toHaveLength(1);
  });

  it("stageInput refuses what it cannot encode", () => {
    expect(stageInput([])).toBeNull();
    expect(stageInput([""])).toBeNull();
    expect(stageInput(["a\0b"])).toBeNull();
    expect(stageInput(Array.from({ length: MAX_STAGE_PATHS + 1 }, () => "a"))).toBeNull();
    expect(stageInput(["a".repeat(MAX_STAGE_BYTES)])).toBeNull();
    expect(stageInput(Array.from({ length: MAX_STAGE_PATHS }, () => "a"))).not.toBeNull();
  });
});
