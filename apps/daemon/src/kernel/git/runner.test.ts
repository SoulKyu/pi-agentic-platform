import { PapError } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { GitError, createGitRunner } from "./runner.ts";

type Result = { stdout: Buffer; stderr: Buffer; code: number };
type Call = {
  file: string;
  args: string[];
  options: Record<string, unknown>;
  input: Buffer | undefined;
  resolve: (r: Partial<Result>) => void;
  reject: (e: unknown) => void;
};

function bed(extra: { maxConcurrent?: number; maxWaiting?: number } = {}) {
  const calls: Call[] = [];
  const { logger, lines } = captureLogger();
  const runner = createGitRunner({
    env: { PATH: "/bin", HOME: "/h", GIT_DIR: "/evil" },
    logger,
    exec: (file, args, options, input) =>
      new Promise<Result>((resolve, reject) => {
        calls.push({
          file,
          args,
          options: { ...options },
          input,
          resolve: (r) => resolve({ stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), code: 0, ...r }),
          reject,
        });
      }),
    ...extra,
  });
  return { runner, calls, lines };
}

function nth<T>(items: T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`no call #${index}`);
  return item;
}

const fail = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error("boom"), { code, ...extra });

describe("the git runner", () => {
  it("runs git with the fixed arguments, the scrubbed environment and the call's limits", async () => {
    const { runner, calls } = bed();
    const done = runner.run("/srv/p", ["status", "--porcelain=v2", "-z"]);
    expect(calls).toHaveLength(1);
    const call = nth(calls, 0);
    expect(call.file).toBe("git");
    expect(call.args.slice(-5)).toEqual(["-C", "/srv/p", "status", "--porcelain=v2", "-z"]);
    expect(call.args[0]).toBe("--no-optional-locks");
    expect(call.options).toMatchObject({
      encoding: "buffer",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 10_000,
      killSignal: "SIGKILL",
      shell: false,
      windowsHide: true,
    });
    const env = call.options.env as Record<string, string>;
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toBe("/srv");
    call.resolve({ stdout: Buffer.from("out") });
    await expect(done).resolves.toEqual({ stdout: Buffer.from("out"), code: 0 });
  });

  it("leads its own process group and passes the input to exec", () => {
    const { runner, calls } = bed();
    const input = Buffer.from("x.log\0");
    void runner.run("/r", ["check-ignore", "-z", "--stdin"], { input });
    expect(nth(calls, 0).options).toMatchObject({ detached: true });
    expect(nth(calls, 0).input).toBe(input);
    void runner.run("/r", ["status"]);
    expect(nth(calls, 1).input).toBeUndefined();
  });

  it("honours per-call timeout and output cap", () => {
    const { runner, calls } = bed();
    void runner.run("/r", ["log"], { timeoutMs: 500, maxBytes: 1024 });
    expect(nth(calls, 0).options).toMatchObject({ timeout: 500, maxBuffer: 1024 });
  });

  it("runs four at once and the fifth waits for a slot", async () => {
    const { runner, calls } = bed();
    const runs = Array.from({ length: 5 }, () => runner.run("/r", ["status"]));
    expect(calls).toHaveLength(4);
    nth(calls, 0).resolve({});
    await runs[0];
    await vi.waitFor(() => expect(calls).toHaveLength(5), { timeout: 1000 });
    for (const c of calls.slice(1)) c.resolve({});
    await Promise.all(runs);
  });

  it("refuses the call after 4 running and 64 waiting with capacity, and does not evict", async () => {
    const { runner, calls } = bed();
    const runs = Array.from({ length: 68 }, () => runner.run("/r", ["status"]));
    await expect(runner.run("/r", ["status"])).rejects.toEqual(new PapError("capacity"));
    expect(calls).toHaveLength(4);
    // Drain: each settled call starts the next waiting one.
    for (let settled = 0; settled < 68; settled += 1) {
      await vi.waitFor(() => expect(calls.length).toBeGreaterThan(settled), { timeout: 1000 });
      nth(calls, settled).resolve({});
    }
    await Promise.all(runs);
    expect(calls).toHaveLength(68);
  });

  it("frees the slot of a rejected call", async () => {
    const { runner, calls } = bed({ maxConcurrent: 1, maxWaiting: 1 });
    const first = runner.run("/r", ["status"]);
    const second = runner.run("/r", ["status"]);
    expect(calls).toHaveLength(1);
    nth(calls, 0).reject(fail("ENOENT"));
    await expect(first).rejects.toMatchObject({ kind: "git_missing" });
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 1000 });
    nth(calls, 1).resolve({});
    await second;
  });

  it("frees the slot of a timed-out call", async () => {
    const { runner, calls } = bed({ maxConcurrent: 1, maxWaiting: 1 });
    const first = runner.run("/r", ["status"]);
    const second = runner.run("/r", ["status"]);
    nth(calls, 0).reject(fail("ETIMEDOUT", { killed: true, signal: "SIGKILL" }));
    await expect(first).rejects.toMatchObject({ kind: "timeout" });
    await vi.waitFor(() => expect(calls).toHaveLength(2), { timeout: 1000 });
    nth(calls, 1).resolve({});
    await second;
  });

  it.each([
    ["ENOENT", {}, "git_missing"],
    ["ABORT", { killed: true, signal: "SIGKILL" }, "timeout"],
    ["ERR_CHILD_PROCESS_STDIO_MAXBUFFER", { killed: true, signal: "SIGKILL" }, "too_large"],
    ["EACCES", {}, "failed"],
  ])("types a %s error as %s", async (code, extra, kind) => {
    const { runner, calls } = bed();
    const done = runner.run("/r", ["status"]);
    nth(calls, 0).reject(fail(code, extra));
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ kind });
  });

  it("types a signal kill without a code as a timeout", async () => {
    const { runner, calls } = bed();
    const done = runner.run("/r", ["status"]);
    nth(calls, 0).reject(Object.assign(new Error("x"), { killed: true, signal: "SIGKILL" }));
    await expect(done).rejects.toMatchObject({ kind: "timeout" });
  });

  it("resolves an exit code listed in okCodes", async () => {
    const { runner, calls } = bed();
    const done = runner.run("/r", ["diff", "--numstat"], { okCodes: [0, 1] });
    nth(calls, 0).resolve({ code: 1, stdout: Buffer.from("d") });
    await expect(done).resolves.toEqual({ stdout: Buffer.from("d"), code: 1 });
  });

  it("rejects an exit code outside okCodes and logs the subcommand and at most 300 characters of stderr", async () => {
    const { runner, calls, lines } = bed();
    const done = runner.run("/secret/place", ["rev-parse", "--show-toplevel"]);
    nth(calls, 0).resolve({ code: 128, stderr: Buffer.from("fatal: ".concat("x".repeat(1000))) });
    const error = await done.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitError);
    expect(error).toMatchObject({ kind: "failed" });
    expect((error as Error).message).toBe("git failed");
    const logged = lines.filter((l) => l.msg === "git_failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ subcommand: "rev-parse", kind: "failed" });
    expect(logged[0]?.stderr).toBe(`fatal: ${"x".repeat(293)}`);
  });

  it("an exit code of 0 is not an error, even when okCodes does not list it by default", async () => {
    const { runner, calls } = bed();
    const done = runner.run("/r", ["status"]);
    nth(calls, 0).resolve({ code: 0 });
    await expect(done).resolves.toMatchObject({ code: 0 });
  });
});

describe("the runner's own arguments (MC12, MC14)", () => {
  const sent = (call: Call) => call.args.slice(call.args.indexOf("-C") + 2);

  it.each(["diff", "log", "show"])(
    "adds --no-ext-diff --no-textconv right after %s, before any --",
    (sub) => {
      const { runner, calls } = bed();
      void runner.run("/r", [sub, "HEAD", "--", "a.txt"]);
      expect(sent(nth(calls, 0))).toEqual([sub, "--no-ext-diff", "--no-textconv", "HEAD", "--", "a.txt"]);
    },
  );

  it("leaves other subcommands alone", () => {
    const { runner, calls } = bed();
    void runner.run("/r", ["status", "--porcelain=v2", "-z"]);
    expect(sent(nth(calls, 0))).toEqual(["status", "--porcelain=v2", "-z"]);
  });

  it.each([
    [["--version"]],
    [["-c", "core.fsmonitor=/x", "status"]],
    [[]],
    [["diff", "--ext-diff"]],
    [["log", "--ext-d"]],
    [["show", "--textconv", "HEAD"]],
    [["diff", "--text"]],
    [["diff", "--submodule=diff"]],
    [["diff", "--sub=diff", "HEAD"]],
    [["log", "--decorate-refs", "--", "--ext-diff", "-p", "-1"]],
    [["show", "--decorate-refs-exclude", "--", "--ext-diff", "HEAD"]],
    [["log", "--decorate-refs", "--", "--textconv", "-p", "-1"]],
    [["show", "--decorate-refs", "--", "--textconv", "HEAD:a.txt"]],
    [["log", "--decorate-refs", "--", "--submodule=diff", "-p", "-1"]],
    [["diff", "HEAD", "--", "--ext-diff"]],
  ])("refuses %j without running git", async (args) => {
    const { runner, calls, lines } = bed();
    await expect(runner.run("/r", args)).rejects.toMatchObject({ kind: "failed" });
    expect(calls).toHaveLength(0);
    expect(lines.filter((l) => l.msg === "git_failed")).toHaveLength(1);
  });

  it("allows an ordinary pathspec after -- that merely contains an option's name", () => {
    const { runner, calls } = bed();
    void runner.run("/r", ["diff", "HEAD", "--", "src/ext-diff.ts"]);
    expect(calls).toHaveLength(1);
  });

  it("calls an external SIGKILL a failure, not a timeout", async () => {
    const { runner, calls } = bed();
    const done = runner.run("/r", ["status"]);
    nth(calls, 0).reject(Object.assign(new Error("x"), { killed: false, signal: "SIGKILL" }));
    await expect(done).rejects.toMatchObject({ kind: "failed" });
  });
});

describe("the subcommand allowlist (MC17)", () => {
  const ALLOWED = [
    "rev-parse",
    "status",
    "diff",
    "log",
    "show",
    "cat-file",
    "ls-files",
    "check-ignore",
    "hash-object",
  ];

  it.each([
    "blame",
    "range-diff",
    "grep",
    "format-patch",
    "difftool",
    "submodule",
    "fetch",
    "pull",
    "clone",
    "update-index",
    "config",
    "help",
    "whatchanged",
    "STATUS",
    "status ",
    "",
  ])("refuses the subcommand %j without running git", async (subcommand) => {
    const { runner, calls, lines } = bed();
    await expect(runner.run("/r", [subcommand])).rejects.toMatchObject({ kind: "failed" });
    expect(calls).toHaveLength(0);
    expect(lines.filter((l) => l.msg === "git_failed")).toHaveLength(1);
  });

  it.each(ALLOWED)("runs %s", async (subcommand) => {
    const { runner, calls } = bed();
    const done = runner.run("/r", [subcommand]);
    expect(calls).toHaveLength(1);
    nth(calls, 0).resolve({});
    await expect(done).resolves.toMatchObject({ code: 0 });
  });
});

describe("the option allowlist (MC18)", () => {
  /** Every argv a planned caller sends, with the plan line it comes from. */
  const PLANNED: Array<[string, string[]]> = [
    ["M8R46 status", ["status", "--porcelain=v2", "-z", "--branch", "--ignore-submodules=dirty"]],
    [
      "M8R46 numstat",
      [
        "diff",
        "--numstat",
        "-z",
        "--ignore-submodules=dirty",
        "--no-ext-diff",
        "--no-textconv",
        "HEAD",
        "--",
      ],
    ],
    ["M8R24 check-ignore", ["check-ignore", "-z", "--stdin", "--no-index"]],
    ["M8R24 check-ignore paths (MC15)", ["check-ignore", "--no-index", "./a.txt", "./:(glob)x"]],
    ["M8R24 ls-files", ["ls-files", "-z", "--cached", "--", "a.txt", "b c.txt"]],
    ["M8R24 ls-files, dash-led name (m15)", ["ls-files", "-z", "--cached", "--", "./-foo"]],
    ["M8R27 ls-files", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]],
    ["M8R47 head side", ["cat-file", "blob", "HEAD:a.txt"]],
    ["M8R47 index side", ["cat-file", "blob", ":a.txt"]],
    ["M8R47 commit side", ["cat-file", "blob", `${"a".repeat(40)}:a.txt`]],
    ["Task 4 repo root", ["rev-parse", "--show-toplevel"]],
    ["Task 4 branch", ["rev-parse", "--abbrev-ref", "HEAD"]],
  ];

  it.each(PLANNED)("accepts %s", (_source, args) => {
    const { runner, calls } = bed();
    void runner.run("/r", args);
    expect(calls).toHaveLength(1);
  });

  it.each([
    // I1: remerge diffs start a merge driver
    [["log", "--remerge-diff", "-1"]],
    [["show", "--remerge-diff", "HEAD"]],
    [["log", "--diff-merges=remerge"]],
    [["log", "--diff-merges=r"]],
    [["log", "--diff-merges", "remerge"]],
    [["log", "-m"]],
    [["show", "-m", "HEAD"]],
    // I2: alternate refs start core.alternateRefsCommand
    [["log", "--alternate-refs"]],
    [["show", "--alternate-refs", "-s"]],
    [["diff", "HEAD", "--alternate-refs"]],
    // I3: status -v diffs through textconv
    [["status", "-v"]],
    [["status", "-vv"]],
    [["status", "--verbose"]],
    [["status", "-bv"]],
    [["status", "--long", "-v"]],
    // abbreviations, clusters, value forms, options git would accept in other spellings
    [["status", "--porcelain"]],
    [["status", "--porcelain=v1"]],
    [["status", "--branch=1"]],
    [["status", "-zb"]],
    [["status", "-z", "-z", "--ignore-submodules"]],
    [["diff", "--num"]],
    [["diff", "-p"]],
    [["diff", "--output=/tmp/x"]],
    [["diff", "--no-index", "--", "/dev/null", "/etc/passwd"]],
    [["log", "-p"]],
    [["log", "-1"]],
    [["log", "--format=%G?"]],
    [["log", "--show-signature"]],
    [["show", "--decorate-refs", "x"]],
    [["cat-file", "-p", "HEAD"]],
    [["cat-file", "--filters", "HEAD:a.txt"]],
    [["cat-file", "--textconv", "HEAD:a.txt"]],
    [["ls-files", "--recurse-submodules"]],
    [["ls-files", "-zo"]],
    [["ls-files", "--others", "--exclude-from=/x"]],
    [["check-ignore", "-v"]],
    // MC15: without --literal-pathspecs a path must start with ./ so that ':(glob)x' cannot be magic
    [["check-ignore", "--no-index", ":(glob)*"]],
    [["check-ignore", "--no-index", "a.txt"]],
    [["check-ignore", "--no-index", "--", ":(top)x"]],
    [["rev-parse", "--git-dir"]],
    [["rev-parse", "--alternate-refs"]],
    [["hash-object", "a.txt"]],
    [["hash-object", "--stdin", "--path=a.txt"]],
    [["hash-object", "-w", "--stdin"]],
    // anything after -- that looks like an option, and a second --
    [["diff", "HEAD", "--", "-p"]],
    [["ls-files", "-z", "--", "--others"]],
    [["status", "--", "--", "a"]],
  ])("refuses %j without running git", async (args) => {
    const { runner, calls, lines } = bed();
    await expect(runner.run("/r", args)).rejects.toMatchObject({ kind: "failed" });
    expect(calls).toHaveLength(0);
    expect(lines.filter((l) => l.msg === "git_failed")).toHaveLength(1);
  });

  it("does not take an inherited property name for a subcommand", async () => {
    const { runner, calls } = bed();
    await expect(runner.run("/r", ["constructor"])).rejects.toMatchObject({ kind: "failed" });
    await expect(runner.run("/r", ["__proto__"])).rejects.toMatchObject({ kind: "failed" });
    expect(calls).toHaveLength(0);
  });
});
