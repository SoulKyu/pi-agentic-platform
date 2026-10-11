import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { bashScript, createHostBed, isApproval, type LaunchOptions } from "./testing/host-bed.ts";

const FAST_HEALTH = fileURLToPath(new URL("./testing/fast-health.ts", import.meta.url));

let bed: ReturnType<typeof createHostBed>;
let pattern = "";
beforeEach(() => {
  bed = createHostBed();
});
afterEach(async () => {
  // Whatever a test failed to stop must not run out its sleep on its own.
  if (pattern) spawnSync("pkill", ["-9", "-f", pattern]);
  pattern = "";
  await bed.dispose();
});

// The commands the model's bash tool runs. Pi starts each one detached, so it leads a group of its own: the
// daemon's signal to the worker's group does not reach it. The second form starts a grandchild in yet another
// session, which not even Pi's own bookkeeping knows about.
// The third element is what `health` counts while it runs: the shell Pi started, and the sleep in the second form.
const COMMANDS = [
  ["a command Pi started detached", (seconds: string) => `sleep ${seconds}`, 1],
  ["a grandchild in a session of its own", (seconds: string) => `setsid sleep ${seconds} & wait`, 2],
] as const;

async function runCommand(command: (seconds: string) => string, options: LaunchOptions = {}) {
  const seconds = `20.${Math.floor(Math.random() * 900) + 100}`;
  pattern = `^sleep ${seconds.replace(".", "[.]")}`;
  const running = () => spawnSync("pgrep", ["-f", pattern]).status === 0;
  await bed.start(bashScript(command(seconds)), options);
  const host = bed.host();
  await host.request({ type: "prompt", message: "go" });
  host.send({ type: "approval_response", id: (await host.waitFor(isApproval)).id, answer: "once" });
  await vi.waitFor(() => expect(running()).toBe(true), { timeout: 5000, interval: 50 });
  const gone = () => vi.waitFor(() => expect(running()).toBe(false), { timeout: 5000, interval: 50 });
  return { host, gone };
}

describe.each(COMMANDS)("pi-host worker: %s", (_name, command, counted) => {
  it("counts it in its health record (M2-RT-14)", async () => {
    const { host, gone } = await runCommand(command, { env: { NODE_OPTIONS: `--import ${FAST_HEALTH}` } });
    await host.waitFor((record) => record.type === "health" && record.descendants === counted);
    host.send({ type: "shutdown", graceMs: 100 });
    expect(await host.exited).toBe(0);
    await gone();
  });

  it.each(["SIGTERM", "SIGHUP"] as const)(
    "is gone after the worker gets %s, and the worker dies of it",
    async (signal) => {
      const { host, gone } = await runCommand(command);
      // kill(0) signals the test runner's own group and kill(1) init: a missing pid must fail the test, not signal.
      const pid = host.child.pid ?? 0;
      expect(pid).toBeGreaterThan(1);
      process.kill(pid, signal);
      await host.exited;
      expect(host.child.signalCode).toBe(signal);
      await gone();
    },
  );

  it("is gone after the daemon closes the channel", async () => {
    const { host, gone } = await runCommand(command);
    host.child.disconnect();
    expect(await host.exited).toBe(0);
    await gone();
  });

  it("is gone after a shutdown", async () => {
    const { host, gone } = await runCommand(command);
    host.send({ type: "shutdown", graceMs: 100 });
    expect(await host.exited).toBe(0);
    await gone();
  });
});
