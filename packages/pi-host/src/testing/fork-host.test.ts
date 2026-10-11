import { fork } from "node:child_process";
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { DEV_EXEC_ARGV, forkHost, NETWORK_GUARD, PI_HOST_MAIN } from "./fork-host.ts";

vi.mock("node:child_process", () => ({
  fork: vi.fn(() =>
    Object.assign(new EventEmitter(), {
      stdout: Object.assign(new EventEmitter(), { resume: () => {} }),
      stderr: new EventEmitter(),
      pid: 1,
    }),
  ),
}));

describe("every worker a test forks runs under the network guard", () => {
  it("passes --import <network guard> to the worker, in its own process group", () => {
    forkHost({ PATH: "/usr/bin" }, "/tmp");
    const [entry, , options] = vi.mocked(fork).mock.calls[0] ?? [];
    expect(entry).toBe(PI_HOST_MAIN);
    const argv = options?.execArgv ?? [];
    expect(argv).toBe(DEV_EXEC_ARGV);
    expect(argv[argv.indexOf("--import") + 1]).toBe(NETWORK_GUARD);
    expect(NETWORK_GUARD.endsWith("/packages/pi-host/src/testing/network-guard.ts")).toBe(true);
    expect(options?.detached).toBe(true);
  });
});
