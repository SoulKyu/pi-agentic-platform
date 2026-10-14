import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { FILTER_SCAN_ARGS } from "./exec.ts";
import { createGitRunner } from "./runner.ts";

function bed() {
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const runner = createGitRunner({
    env: { PATH: "/bin", HOME: "/h", GIT_CONFIG_COUNT: "9", GIT_CONFIG_KEY_0: "core.pager" },
    logger: captureLogger().logger,
    exec: async (_file, args, options) => {
      seen.push({ args, env: options.env });
      return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 };
    },
  });
  return { runner, seen };
}

describe("the runner and MC13", () => {
  it("accepts the one config call the filter guard makes, and no other config call", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", FILTER_SCAN_ARGS);
    expect(seen).toHaveLength(1);
    for (const args of [
      ["config"],
      ["config", "core.pager", "evil"],
      ["config", "--get-regexp", "^filter\\."],
      [...FILTER_SCAN_ARGS, "core.pager", "evil"],
      ["config", "--null", "--show-scope", "--get-regexp", "^filter\\.", "--file", "/x"],
    ])
      await expect(runner.run("/r", args), args.join(" ")).rejects.toMatchObject({ kind: "failed" });
    expect(seen).toHaveLength(1);
  });

  it("adds the caller's config entries to git's environment, over nothing the daemon had", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", ["status"], {
      env: { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.x.clean", GIT_CONFIG_VALUE_0: "" },
    });
    await runner.run("/r", ["status"]);
    expect(seen[0]?.env).toMatchObject({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "filter.x.clean" });
    expect(seen[1]?.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(seen[1]?.env.GIT_CONFIG_KEY_0).toBeUndefined();
  });

  it.each([
    "GIT_EXEC_PATH",
    "GIT_DIR",
    "PATH",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_KEY_",
    "GIT_CONFIG_KEY_x",
    "GIT_CONFIG_KEY_1234",
    "GIT_CONFIG_COUNT_0",
  ])("refuses an environment variable called %s", async (name) => {
    const { runner, seen } = bed();
    await expect(runner.run("/r", ["status"], { env: { [name]: "/evil" } })).rejects.toMatchObject({
      kind: "failed",
    });
    expect(seen).toEqual([]);
  });
});
