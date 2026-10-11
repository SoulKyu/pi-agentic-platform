import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { countAgentProcesses } from "./descendants.ts";

// A stand-in for the worker: it leads a group of its own (detached), as the daemon forks the real one, and starts
// one `sleep` in a session of its own (what Pi's bash tool does) and one in its own group (an MCP server's helper).
const STAND_IN = `
const { spawn } = require("node:child_process");
const own = spawn("sleep", ["30"], { stdio: "ignore", detached: true });
const helper = spawn("sleep", ["30"], { stdio: "ignore" });
console.log(JSON.stringify({ own: own.pid, helper: helper.pid }));
setInterval(() => {}, 1000);
`;

let standIn: ReturnType<typeof spawn> | null = null;
const pids: number[] = [];
afterEach(() => {
  for (const pid of [standIn?.pid, ...pids]) {
    if (pid !== undefined && pid > 1) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
  standIn = null;
  pids.length = 0;
});

describe.runIf(process.platform === "linux")("countAgentProcesses on the real /proc", () => {
  it("counts a child in a group of its own, not one in the worker's group, and not a process that exited", async () => {
    standIn = spawn(process.execPath, ["-e", STAND_IN], {
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
    });
    const worker = standIn.pid ?? 0;
    expect(worker).toBeGreaterThan(1);
    const said = await new Promise<string>((resolve) =>
      standIn?.stdout?.once("data", (chunk) => resolve(String(chunk))),
    );
    const { own, helper } = JSON.parse(said) as { own: number; helper: number };
    pids.push(own, helper);
    expect(countAgentProcesses({ pid: worker })).toBe(1);
    process.kill(own, "SIGKILL");
    await vi.waitFor(() => expect(countAgentProcesses({ pid: worker })).toBe(0), { timeout: 5000 });
  });

  it("is 0 for the test runner, which does not lead its group", () => {
    expect(countAgentProcesses()).toBe(0);
  });
});
