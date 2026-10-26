import { describe, expect, it } from "vitest";
import { AGENTS_ROOT, agentOfPath, underAgents } from "./agent-path.ts";

describe("agentOfPath", () => {
  it("matches an agent's folder and what is below it", () => {
    expect(agentOfPath("/agents/helper-1a2b")).toEqual({
      agentId: "helper-1a2b",
      root: "/agents/helper-1a2b",
    });
    expect(agentOfPath("/agents/helper-1a2b/home/x")).toEqual({
      agentId: "helper-1a2b",
      root: "/agents/helper-1a2b",
    });
    expect(agentOfPath("/agents/helper-1a2b3c4d")?.agentId).toBe("helper-1a2b3c4d");
  });

  it("refuses everything else", () => {
    for (const path of [
      "/agents",
      "/agents/",
      "/agents/helper-1a2b/../x",
      "/agents/helper-1a2bX",
      "/agents//helper-1a2b",
      "/agents/Bad_Id",
      "/agents/helper-1a2b/",
      "/agent/helper-1a2b",
      "agents/helper-1a2b",
      "/x/agents/helper-1a2b",
    ])
      expect(agentOfPath(path), path).toBeNull();
  });
});

describe("underAgents", () => {
  it("is true at /agents and below, whatever the spelling", () => {
    expect(AGENTS_ROOT).toBe("/agents");
    for (const path of ["/agents", "/agents/", "/agents/x", "/agents//x", "/agents/helper-1a2b/../x"])
      expect(underAgents(path), path).toBe(true);
    for (const path of ["/agentsx", "/agent", "/", "/home/agents", "agents"])
      expect(underAgents(path), path).toBe(false);
  });
});
