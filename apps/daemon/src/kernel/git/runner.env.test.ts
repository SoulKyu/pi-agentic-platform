import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createGitRunner, PAP_IDENTITY } from "./runner.ts";

const INDEX_DIR = "/pap/tmp/git-index";
const GOOD_INDEX = `${INDEX_DIR}/idx-0123456789abcdef0123456789abcdef`;

function bed() {
  const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
  const { logger, lines } = captureLogger();
  const runner = createGitRunner({
    env: { PATH: "/bin", HOME: "/h" },
    logger,
    indexDir: INDEX_DIR,
    exec: async (_file, args, options) => {
      seen.push({ args, env: options.env });
      return { stdout: Buffer.alloc(0), stderr: Buffer.from("e".repeat(1000)), code: 1 };
    },
  });
  return { runner, seen, lines };
}

const okCodes = { okCodes: [0, 1] } as const;

describe("the system git config", () => {
  it("is switched off on every call", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", ["status"], okCodes).catch(() => undefined);
    expect(seen[0]?.env.GIT_CONFIG_NOSYSTEM).toBe("1");
  });
});

describe("the extra environment (M9R11)", () => {
  it.each([
    ["GIT_DIR", "/evil"],
    ["GIT_WORK_TREE", "/evil"],
    ["GIT_AUTHOR_NAME", "evil"],
    ["GIT_COMMITTER_EMAIL", "evil@example.com"],
    ["GIT_AUTHOR_NAME", `${PAP_IDENTITY.name} `],
    ["GIT_LFS_SKIP_SMUDGE", "0"],
    ["GIT_EDITOR", "evil"],
    ["GIT_INDEX_FILE", "/pap/tmp/other/idx-0123456789abcdef0123456789abcdef"],
    ["GIT_INDEX_FILE", `${INDEX_DIR}/../idx-0123456789abcdef0123456789abcdef`],
    ["GIT_INDEX_FILE", `${INDEX_DIR}/../x`],
    ["GIT_INDEX_FILE", `${INDEX_DIR}/idx-short`],
    ["GIT_INDEX_FILE", `${INDEX_DIR}/idx-0123456789abcdef0123456789abcdeg`],
    ["GIT_INDEX_FILE", `${INDEX_DIR}/sub/idx-0123456789abcdef0123456789abcdef`],
  ])("refuses %s=%s before git starts", async (name, value) => {
    const { runner, seen } = bed();
    await expect(runner.run("/r", ["status"], { ...okCodes, env: { [name]: value } })).rejects.toMatchObject({
      kind: "failed",
    });
    expect(seen).toHaveLength(0);
  });

  it("passes a temporary index, pap's identity and the LFS switch", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", ["read-tree", "HEAD"], {
      ...okCodes,
      env: {
        GIT_INDEX_FILE: GOOD_INDEX,
        GIT_AUTHOR_NAME: PAP_IDENTITY.name,
        GIT_AUTHOR_EMAIL: PAP_IDENTITY.email,
        GIT_COMMITTER_NAME: PAP_IDENTITY.name,
        GIT_COMMITTER_EMAIL: PAP_IDENTITY.email,
        GIT_LFS_SKIP_SMUDGE: "1",
      },
    });
    expect(seen[0]?.env).toMatchObject({
      GIT_INDEX_FILE: GOOD_INDEX,
      GIT_AUTHOR_NAME: "pap",
      GIT_AUTHOR_EMAIL: "pap@users.noreply.invalid",
      GIT_COMMITTER_NAME: "pap",
      GIT_COMMITTER_EMAIL: "pap@users.noreply.invalid",
      GIT_LFS_SKIP_SMUDGE: "1",
    });
  });

  it("refuses read-tree without a temporary index, and never starts git", async () => {
    const { runner, seen } = bed();
    await expect(runner.run("/r", ["read-tree", "HEAD"])).rejects.toMatchObject({ kind: "failed" });
    await expect(runner.run("/r", ["read-tree", "--empty"])).rejects.toMatchObject({ kind: "failed" });
    expect(seen).toHaveLength(0);
  });

  it("refuses an index file when the runner has no index directory", async () => {
    const runner = createGitRunner({
      env: { PATH: "/bin" },
      logger: captureLogger().logger,
      exec: async () => ({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0 }),
    });
    await expect(
      runner.run("/r", ["read-tree", "HEAD"], { env: { GIT_INDEX_FILE: GOOD_INDEX } }),
    ).rejects.toMatchObject({
      kind: "failed",
    });
  });

  it("pins the editors in git's environment", async () => {
    const { runner, seen } = bed();
    await runner.run("/r", ["status"], okCodes);
    expect(seen[0]?.env).toMatchObject({ GIT_EDITOR: ":", GIT_SEQUENCE_EDITOR: ":" });
  });

  it("logs at most 300 characters of a failing call's stderr", async () => {
    const { runner, lines } = bed();
    await expect(runner.run("/r", ["status"])).rejects.toMatchObject({ kind: "failed" });
    const logged = JSON.stringify(lines);
    expect(logged).toContain("e".repeat(300));
    expect(logged).not.toContain("e".repeat(301));
  });
});
