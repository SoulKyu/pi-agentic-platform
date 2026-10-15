import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createGitRunner } from "./runner.ts";

const PUSH = ["push", "--porcelain", "--set-upstream", "origin", "refs/heads/pi/x:refs/heads/pi/x"];

function bed(protocols?: string, stderr = "") {
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const { logger, lines } = captureLogger();
  const runner = createGitRunner({
    env: { PATH: "/bin", HOME: "/h", SSH_AUTH_SOCK: "/agent", HTTPS_PROXY: "http://p" },
    logger,
    ...(protocols === undefined ? {} : { remoteProtocols: protocols }),
    exec: async (_file, args, options) => {
      seen.push({ args, env: options.env });
      return { stdout: Buffer.from("out"), stderr: Buffer.from(stderr), code: 0 };
    },
  });
  return { runner, seen, lines };
}

describe("the remote profile through the runner (M9R10)", () => {
  it("a push under local is refused before git starts", async () => {
    const { runner, seen } = bed();
    await expect(runner.run("/r", PUSH)).rejects.toMatchObject({ kind: "failed" });
    expect(seen).toHaveLength(0);
  });

  it("a local read under the remote profile is refused before git starts", async () => {
    const { runner, seen } = bed();
    await expect(runner.run("/r", ["status"], { profile: "remote" })).rejects.toMatchObject({
      kind: "failed",
    });
    expect(seen).toHaveLength(0);
  });

  it("a push carries the remote -c set, the agent and the production protocols", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", PUSH, { profile: "remote" });
    expect(seen[0]?.args).not.toContain("protocol.allow=never");
    expect(seen[0]?.args).toContain("push.followTags=false");
    expect(seen[0]?.env).toMatchObject({
      SSH_AUTH_SOCK: "/agent",
      HTTPS_PROXY: "http://p",
      GIT_ALLOW_PROTOCOL: "https:ssh",
    });
  });

  it("remoteProtocols replaces the protocols for a push only", async () => {
    const { runner, seen } = bed("file");
    await runner.run("/r", PUSH, { profile: "remote" });
    await runner.run("/r", ["status"]);
    expect(seen[0]?.env.GIT_ALLOW_PROTOCOL).toBe("file");
    expect(seen[1]?.env.GIT_ALLOW_PROTOCOL).toBe("");
    expect(seen[1]?.env.SSH_AUTH_SOCK).toBeUndefined();
  });
});

describe("keepStderr (M9R12)", () => {
  it("returns git's stderr text, and only when asked", async () => {
    const { runner } = bed(undefined, "rejected: non-fast-forward\n");
    expect((await runner.run("/r", ["status"])).stderr).toBeUndefined();
    expect((await runner.run("/r", ["status"], { keepStderr: true })).stderr).toBe(
      "rejected: non-fast-forward\n",
    );
  });
});
