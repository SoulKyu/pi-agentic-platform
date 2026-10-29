import { AgentInput } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createAgentSurface } from "./agent-surface.ts";
import type { AgentProfile } from "./agent-gate.ts";

const profile = (network: boolean): AgentProfile => ({
  input: AgentInput.parse({ name: "Atlas", sandbox: { required: true, network } }),
  name: "Atlas",
  quarantined: false,
});

function surface(registry: AgentProfile | null) {
  const { logger } = captureLogger();
  const made = createAgentSurface({
    store: { get: () => undefined, readOnly: false } as never,
    policy: {} as never,
    clock: {} as never,
    logger,
    worker: { papHome: "/pap", agentDir: "/pi" },
  });
  made.setAgentPorts({ agents: { profileOf: () => registry } } as never);
  return made;
}

describe("shellNetwork: the network the session's own shell was started with (UX2-R68)", () => {
  it("is the start-time profile's sandbox.network", () => {
    const s = surface(null);
    s.started("on", profile(true));
    s.started("off", profile(false));
    expect(s.shellNetwork("on")).toBe(true);
    expect(s.shellNetwork("off")).toBe(false);
  });

  it("ignores the registry's current profile: network turned on after the worker started stays off", () => {
    const s = surface(profile(true));
    s.started("t", profile(false));
    expect(s.shellNetwork("t")).toBe(false);
  });

  it("is null without a start-time profile (no worker), and after the worker ended", () => {
    const s = surface(profile(true));
    expect(s.shellNetwork("t")).toBeNull();
    s.started("t", profile(true));
    s.ended("t");
    expect(s.shellNetwork("t")).toBeNull();
  });
});
