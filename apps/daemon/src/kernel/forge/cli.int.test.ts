import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeStubForge, type StubAnswer } from "../../testing/stub-forge.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createSystemClock } from "../clock.ts";
import { forgeEnv, runForge } from "./cli.ts";
import { githubForge } from "./github.ts";

let dir: string;
let forgeDir: string;
let stubDir: string;
const HOSTILE = {
  PATH: process.env.PATH,
  HOME: "/home/x",
  GH_TOKEN: "t",
  SSH_AUTH_SOCK: "/tmp/agent",
  PAP_HOME: "/pap",
};
const baseEnv = (): Record<string, string | undefined> => ({
  ...HOSTILE,
  PATH: `${stubDir}:${process.env.PATH ?? ""}`,
});

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-forge-")));
  forgeDir = join(dir, "forge");
  stubDir = join(dir, "stub");
  mkdirSync(forgeDir, { mode: 0o700 });
  mkdirSync(stubDir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (
  answers: StubAnswer[],
  over: { timeoutMs?: number; input?: string; maxStdoutBytes?: number } = {},
) => {
  const stub = writeStubForge(stubDir, answers);
  const { logger, lines } = captureLogger();
  const promise = runForge("gh", ["pr", "view", "1"], {
    cwd: forgeDir,
    env: forgeEnv(baseEnv(), forgeDir),
    timeoutMs: over.timeoutMs ?? 10_000,
    input: over.input,
    maxStdoutBytes: over.maxStdoutBytes,
    logger,
    clock: createSystemClock(),
    forge: "github",
    op: "view",
  });
  return { stub, promise, lines };
};

describe("runForge against a stub gh", () => {
  it("runs in the empty forge folder with the unattended environment and the body on stdin", async () => {
    const body = 'line one\né "quoted" $(x)\n\nlast';
    const { stub, promise } = run([{ stdout: "hello" }], { input: body });
    expect(await promise).toEqual({ ok: true, stdout: "hello" });
    const [call] = stub.calls();
    expect(call?.argv).toEqual(["pr", "view", "1"]);
    expect(call?.cwd).toBe(forgeDir);
    expect(call?.stdin).toBe(body);
    expect(call?.envKeys).not.toContain("GH_TOKEN");
    expect(call?.envKeys).not.toContain("SSH_AUTH_SOCK");
    expect(call?.envKeys.filter((key) => key.startsWith("PAP_"))).toEqual([]);
    expect(call?.envKeys).toContain("GH_PROMPT_DISABLED");
  });

  it("kills a stub that outlives the deadline, with its process", async () => {
    const { stub, promise, lines } = run([{ sleepMs: 30_000 }], { timeoutMs: 300 });
    expect(await promise).toEqual({ ok: false, outcome: "timeout" });
    const pid = stub.calls()[0]?.pid ?? 0;
    expect(pid).toBeGreaterThan(1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(lines.find((line) => line.msg === "forge_failed")).toMatchObject({
      forge: "github",
      op: "view",
      outcome: "timeout",
    });
  });

  it("answers forge_missing for a missing binary", async () => {
    const { logger } = captureLogger();
    const result = await runForge("gh-does-not-exist", [], {
      cwd: forgeDir,
      env: forgeEnv(baseEnv(), forgeDir),
      timeoutMs: 5000,
      logger,
      clock: createSystemClock(),
      forge: "github",
      op: "view",
    });
    expect(result).toEqual({ ok: false, outcome: "forge_missing" });
  });

  it("classifies stderr and logs at most 300 characters of it", async () => {
    const { promise, lines } = run([{ exitCode: 1, stderr: `gh auth login ${"e".repeat(1000)}` }]);
    expect(await promise).toEqual({ ok: false, outcome: "not_signed_in" });
    const line = lines.find((entry) => entry.msg === "forge_failed");
    expect(line).toMatchObject({ outcome: "not_signed_in", code: 1 });
    expect(String(line?.stderr).length).toBeLessThanOrEqual(300);
  });

  it("answers too_large past the stdout cap", async () => {
    const { promise } = run([{ stdoutBytes: 5000 }], { maxStdoutBytes: 1000 });
    expect(await promise).toEqual({ ok: false, outcome: "too_large" });
  });
});

describe("githubForge against a stub gh", () => {
  it("creates a pull request from the folder, the body on stdin, and reads the number from the URL", async () => {
    const stub = writeStubForge(stubDir, [{ stdout: "https://github.com/o/r/pull/42\n" }]);
    const { logger } = captureLogger();
    const forge = githubForge({ env: baseEnv(), forgeDir, logger, clock: createSystemClock() });
    const result = await forge.createPr(
      { host: "github.com", path: "o/r" },
      { head: "pap/x", base: "main", title: "-t", body: "body\n", draft: true },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { number: 42, url: "https://github.com/o/r/pull/42", state: "open", draft: true },
    });
    const [call] = stub.calls();
    expect(call?.stdin).toBe("body\n");
    expect(call?.cwd).toBe(forgeDir);
    expect(call?.argv).toContain("--title=-t");
  });

  it("finds, views and maps JSON, and refuses a malformed answer", async () => {
    writeStubForge(stubDir, [
      {
        stdout: JSON.stringify([
          {
            number: 9,
            url: "https://github.com/f/r/pull/9",
            state: "OPEN",
            isDraft: false,
            isCrossRepository: true,
          },
          {
            number: 5,
            url: "https://github.com/o/r/pull/5",
            state: "OPEN",
            isDraft: false,
            isCrossRepository: false,
          },
        ]),
      },
      { stdout: JSON.stringify([]) },
      { stdout: "{not json" },
      {
        stdout: JSON.stringify({
          number: 1,
          title: "t",
          body: "b",
          state: "OPEN",
          labels: [{ name: "bug" }],
          url: "https://github.com/o/r/issues/1",
        }),
      },
    ]);
    const { logger } = captureLogger();
    const forge = githubForge({ env: baseEnv(), forgeDir, logger, clock: createSystemClock() });
    const repo = { host: "github.com", path: "o/r" };
    expect(await forge.findPr(repo, "pap/x")).toMatchObject({
      ok: true,
      value: { number: 5, state: "open" },
    });
    expect(await forge.findPr(repo, "pap/x")).toEqual({ ok: true, value: null });
    expect(await forge.viewPr(repo, 5)).toEqual({ ok: false, outcome: "failed" });
    expect(await forge.viewIssue(repo, 1)).toMatchObject({
      ok: true,
      value: { labels: ["bug"], forge: "github" },
    });
  });
});

describe("the forge folder in a repository", () => {
  it("lets no git child of the CLI discover the repository above it", () => {
    const home = join(dir, "home");
    const nested = join(home, "pap", "tmp", "forge");
    mkdirSync(nested, { recursive: true });
    execFileSync("git", ["init", "-q", home], { env: { PATH: process.env.PATH, HOME: dir } });
    const env = forgeEnv(baseEnv(), nested);
    const git = (cwd: string) => spawnSync("git", ["rev-parse", "--git-dir"], { cwd, env, encoding: "utf8" });
    expect(git(home).status).toBe(0);
    const result = git(nested);
    expect(result.status).toBe(128);
    expect(result.stderr).toContain("not a git repository");
  });
});

describe("a stray process that holds the CLI's output", () => {
  it("does not keep the call past the deadline and the pipe grace", async () => {
    const pidFile = join(dir, "stray.pid");
    const script = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const stray = spawn("sleep", ["30"], { detached: true, stdio: ["ignore", "inherit", "inherit"] });
fs.writeFileSync(${JSON.stringify(pidFile)}, String(stray.pid));
setTimeout(() => {}, 30000);
`;
    writeFileSync(join(stubDir, "gh"), script);
    chmodSync(join(stubDir, "gh"), 0o755);
    const { logger, lines } = captureLogger();
    try {
      const result = await runForge("gh", [], {
        cwd: forgeDir,
        env: forgeEnv(baseEnv(), forgeDir),
        timeoutMs: 300,
        pipeGraceMs: 200,
        logger,
        clock: createSystemClock(),
        forge: "github",
        op: "view",
      });
      expect(result).toEqual({ ok: false, outcome: "timeout" });
      expect(lines.find((line) => line.msg === "forge_failed")).toMatchObject({ outcome: "timeout" });
    } finally {
      const stray = Number(readFileSync(pidFile, "utf8"));
      if (stray > 1) process.kill(stray, "SIGKILL");
    }
  });
});
