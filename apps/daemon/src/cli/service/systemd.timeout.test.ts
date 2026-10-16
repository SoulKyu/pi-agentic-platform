import { beforeEach, describe, expect, it, vi } from "vitest";

const timeouts: Array<{ args: readonly string[]; timeout: number }> = [];
vi.mock("node:child_process", () => ({
  execFile: (
    _bin: string,
    args: readonly string[],
    options: { timeout: number },
    done: (error: null, stdout: string) => void,
  ) => {
    timeouts.push({ args, timeout: options.timeout });
    done(null, "");
  },
}));

const { createSystemd } = await import("./systemd.ts");

beforeEach(() => timeouts.splice(0));

describe("systemctl timeouts", () => {
  it("restart and stop wait 42 s (the unit's 32 s TimeoutStopSec plus 10 s), the other verbs 15 s", async () => {
    const systemd = createSystemd({ PATH: "/x" });
    await systemd.restart("pap.service");
    await systemd.stop("pap.service");
    await systemd.enable("pap.service");
    await systemd.disable("pap.service");
    expect(timeouts.map((t) => [t.args[1], t.timeout])).toEqual([
      ["restart", 42_000],
      ["stop", 42_000],
      ["enable", 15_000],
      ["disable", 15_000],
    ]);
  });
});
