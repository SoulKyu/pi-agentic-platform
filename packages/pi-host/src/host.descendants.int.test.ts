import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bashScript, createHostBed, isApproval } from "./testing/host-bed.ts";

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
const COMMANDS = [
  ["a command Pi started detached", (seconds: string) => `sleep ${seconds}`],
  ["a grandchild in a session of its own", (seconds: string) => `setsid sleep ${seconds} & wait`],
] as const;

async function runCommand(command: (seconds: string) => string) {
  const seconds = `20.${Math.floor(Math.random() * 900) + 100}`;
  pattern = `^sleep ${seconds.replace(".", "[.]")}`;
  const running = () => spawnSync("pgrep", ["-f", pattern]).status === 0;
  await bed.start(bashScript(command(seconds)));
  const host = bed.host();
  await host.request({ type: "prompt", message: "go" });
  host.send({ type: "approval_response", id: (await host.waitFor(isApproval)).id, answer: "once" });
  await vi.waitFor(() => expect(running()).toBe(true), { timeout: 5000, interval: 50 });
  const gone = () => vi.waitFor(() => expect(running()).toBe(false), { timeout: 5000, interval: 50 });
  return { host, gone };
}

describe.each(COMMANDS)("pi-host worker: %s", (_name, command) => {
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
