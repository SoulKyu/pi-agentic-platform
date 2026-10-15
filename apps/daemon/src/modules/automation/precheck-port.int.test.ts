import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSystemClock } from "../../kernel/clock.ts";
import { createLogger } from "../../kernel/logger.ts";
import type { WorkerScopes } from "../../kernel/supervisor/scope.ts";
import { createPrecheckPort, systemPrecheckDeps } from "./precheck-port.ts";

const WAIT = { timeout: 10_000, interval: 25 } as const;
let dir: string;
let lines: string[];
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "pap-precheck-port-")));
  lines = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const logger = () =>
  createLogger({ level: "debug", clock: createSystemClock(), write: (line) => void lines.push(line) });
function port(options: { timeoutMs?: number; scopes?: Pick<WorkerScopes, "next"> } = {}) {
  const spans: Array<Record<string, unknown>> = [];
  const made = createPrecheckPort({
    logger: logger(),
    env: { PATH: process.env.PATH, HOME: dir, FROM_DAEMON: "daemon-value", ANTHROPIC_API_KEY: "sk-secret" },
    runner: systemPrecheckDeps(createSystemClock()),
    timeoutMs: options.timeoutMs,
    scopes: options.scopes,
    span: () => ({ end: (outcome, attrs) => void spans.push({ outcome, ...attrs }) }),
  });
  return { port: made, spans };
}
const input = (command: string, over: Record<string, unknown> = {}) => ({
  command,
  cwd: dir,
  env: [] as string[],
  triggerId: "t1",
  origin: "manual" as const,
  ...over,
});

describe("the precheck port over a real shell (M10R69, M10R70, M10R71)", () => {
  it("passes the named variable and never a provider key, and answers the output", async () => {
    const { port: precheck } = port();
    const outcome = await precheck.run(
      input('echo "$FROM_DAEMON/${ANTHROPIC_API_KEY:-none}"', { env: ["FROM_DAEMON"] }),
    );
    expect(outcome).toMatchObject({ verdict: "pass", exitCode: 0, output: "daemon-value/none\n" });
  });

  it("answers a skip with the stripped first line as the detail", async () => {
    const { port: precheck } = port();
    expect(await precheck.run(input("echo 'nothing new'; exit 1"))).toMatchObject({
      verdict: "skip",
      exitCode: 1,
      detail: "nothing new",
    });
  });

  it.each([
    ["exit 7", "precheck exit 7"],
    ["kill -9 $$", "precheck signal"],
  ])("answers the fixed detail of %s", async (command, detail) => {
    const { port: precheck } = port();
    expect(await precheck.run(input(command))).toMatchObject({ verdict: "error", detail });
  });

  it("answers precheck timeout at the deadline", async () => {
    const { port: precheck } = port({ timeoutMs: 200 });
    expect(await precheck.run(input("sleep 60"))).toMatchObject({
      verdict: "error",
      detail: "precheck timeout",
    });
  });

  it("answers precheck busy for a second precheck of the same trigger while one runs", async () => {
    const { port: precheck } = port();
    const first = precheck.run(input("sleep 0.3; exit 0"));
    expect(await precheck.run(input("exit 0"))).toMatchObject({ verdict: "error", detail: "precheck busy" });
    expect(await first).toMatchObject({ verdict: "pass" });
  });

  it("stop() aborts a running precheck and refuses the next", async () => {
    const { port: precheck } = port();
    const running = precheck.run(input(`echo $$ > run.pid; sleep 60`));
    await vi.waitFor(() => expect(readFileSync(join(dir, "run.pid"), "utf8")).not.toBe(""), WAIT);
    precheck.stop();
    expect(await running).toMatchObject({ verdict: "error", detail: "precheck aborted" });
    expect(await precheck.run(input("exit 0", { triggerId: "t2" }))).toMatchObject({
      verdict: "error",
      detail: "precheck aborted",
    });
  });

  it("aborts a running precheck when the signal given with the input aborts (a feed poll past its deadline)", async () => {
    const { port: precheck } = port();
    const controller = new AbortController();
    const running = precheck.run(input(`echo $$ > run.pid; sleep 60`, { signal: controller.signal }));
    await vi.waitFor(() => expect(readFileSync(join(dir, "run.pid"), "utf8")).not.toBe(""), WAIT);
    controller.abort();
    expect(await running).toMatchObject({ verdict: "error", detail: "precheck aborted" });
    expect(await precheck.run(input("exit 0"))).toMatchObject({ verdict: "pass" });
  });

  it("runs nothing when the signal is already aborted", async () => {
    const { port: precheck } = port();
    expect(await precheck.run(input("echo ran > ran.txt", { signal: AbortSignal.abort() }))).toMatchObject({
      verdict: "error",
      detail: "precheck aborted",
    });
    expect(() => readFileSync(join(dir, "ran.txt"), "utf8")).toThrow();
  });

  it("answers precheck spawn for a missing folder", async () => {
    const { port: precheck } = port();
    expect(await precheck.run(input("exit 0", { cwd: join(dir, "missing") }))).toMatchObject({
      verdict: "error",
      detail: "precheck spawn",
    });
  });

  it("logs precheck_run without the command or the output, and records a span of closed values", async () => {
    const { port: precheck, spans } = port();
    await precheck.run(input("echo SECRET-OUTPUT-42; exit 0 # SECRET-COMMAND-17"));
    const log = lines.join("\n");
    expect(log).toContain("precheck_run");
    expect(log).toContain('"verdict":"fire"');
    expect(log).not.toContain("SECRET-OUTPUT-42");
    expect(log).not.toContain("SECRET-COMMAND-17");
    expect(JSON.stringify(spans)).not.toContain("SECRET");
    expect(spans).toEqual([expect.objectContaining({ outcome: "ok", verdict: "fire" })]);
  });

  it("takes a scope per precheck, runs the shell behind its launch and reaps it after the exit", async () => {
    const reaped = vi.fn(async () => ({ oomKilled: false }));
    const scopes: Pick<WorkerScopes, "next"> = {
      next: vi.fn(() => ({
        unit: "pap-x-term-1.scope",
        launch: { command: "/usr/bin/env", args: ["SCOPED=1"], env: { XDG_RUNTIME_DIR: "/run/user/9" } },
        reap: reaped,
      })),
    };
    const { port: precheck } = port({ scopes });
    expect(await precheck.run(input("echo $SCOPED $XDG_RUNTIME_DIR"))).toMatchObject({
      verdict: "pass",
      output: "1 /run/user/9\n",
    });
    expect(scopes.next).toHaveBeenCalledWith({ kind: "terminal" });
    await vi.waitFor(() => expect(reaped).toHaveBeenCalledTimes(1), WAIT);
  });
});
