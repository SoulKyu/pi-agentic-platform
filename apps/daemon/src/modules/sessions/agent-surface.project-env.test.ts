import { describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import { createAgentSurface } from "./agent-surface.ts";
import type { ProjectLaunch } from "./project-gate.ts";

const launch: ProjectLaunch = {
  project: { id: "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11" },
  resources: { memoryMb: 2048, cpus: 2, diskMb: 8192 },
  scope: "/boxes/p/project",
  home: "/boxes/p/home",
  vm: true,
};
const BRIDGE_ENV = { IS_SANDBOX: "1", CLAUDE_CONFIG_DIR: "/boxes/p/home/.claude" };

function surface(token: boolean, env: Record<string, string>) {
  const claudeEnvOf = vi.fn(async () => env);
  const s = createAgentSurface({
    store: { get: () => undefined, readOnly: false } as never,
    policy: {} as never,
    clock: {} as never,
    logger: silentLogger,
    worker: { papHome: "/pap", agentDir: "/pi" },
  });
  s.setAgentPorts({
    agents: {
      profileOf: () => null,
      claudeEnvOf,
      boxes: {
        projectOf: () => null,
        box: () => null,
        claudeTokenSet: () => token,
        addHost: () => undefined,
      },
    },
  });
  return { s, claudeEnvOf };
}

describe("a project launch's Claude Code environment (ADR 0080)", () => {
  it("carries IS_SANDBOX and a CLAUDE_CONFIG_DIR under the box's home when the token is set and the bridge is present", async () => {
    const { s, claudeEnvOf } = surface(true, BRIDGE_ENV);
    expect((await s.projectEnv(launch)).claudeEnv).toEqual(BRIDGE_ENV);
    // The agents' own rule decides, in the VM, with the box's home.
    expect(claudeEnvOf).toHaveBeenCalledWith(expect.anything(), { vm: true, home: "/boxes/p/home" });
  });
  it("carries none without the token, and none when the bridge is not among the owner's packages", async () => {
    const noToken = surface(false, BRIDGE_ENV);
    expect(await noToken.s.projectEnv(launch)).toBe(launch);
    expect(noToken.claudeEnvOf).not.toHaveBeenCalled();
    expect(await surface(true, {}).s.projectEnv(launch)).toBe(launch);
  });
});
