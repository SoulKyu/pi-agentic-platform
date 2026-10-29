import { describe, expect, it } from "vitest";
import { previewsLate } from "./compose-previews-late.ts";

const PROJECT = "0b1c2d3e-0000-4000-8000-000000000001";

describe("previewsLate", () => {
  const redact = async (line: string) => line;
  const agentOps = { name: "agent ops" };
  const projectOps = { name: "project ops" };
  const platform = { register: () => undefined };
  const sessions = {
    projectBoxOf: () => null,
    shellNetwork: () => null,
    modeOf: () => "full-access" as const,
    entryText: async () => null,
  };
  const late = previewsLate({
    vm: {
      runtime: { phase: () => "running", link: () => undefined, onPhase: () => () => undefined } as never,
      redact,
      hostsOf: () => null,
    },
    boxes: {
      workspace: {
        boxOps: () => projectOps,
        agentOps: () => agentOps,
        boxes: () => ({ box: (id: string) => (id === PROJECT ? { ownerId: "u1" } : null) }),
      },
    } as never,
    sessions,
    m11: { platform, agents: { ownerOf: (id: string) => (id === "atlas-0001" ? "u2" : null) } } as never,
  });

  it("hands the previews the VM's redactor, the platform port and the sessions' own facts, unchanged", () => {
    expect(late.service?.redact).toBe(redact);
    expect(late.service?.platform).toBe(platform);
    expect(late.service?.sessions).toBe(sessions);
  });

  it("hands the previews the sessions' transcript read and the proxy's host lists", () => {
    expect(late.entryText).toBe(sessions.entryText);
    expect(late.service?.hostsOf({ kind: "agent", id: "atlas-0001" })).toBeNull();
  });

  it("gives the project boxes' ops to project boxes and the agents' ops to agent VMs", () => {
    expect(late.service?.ops).toEqual({ project: projectOps, agent: agentOps });
  });

  it("names a box's owner from the projects' and the agents' records", () => {
    expect(late.service?.owners.project(PROJECT)).toBe("u1");
    expect(late.service?.owners.project("other")).toBeNull();
    expect(late.service?.owners.agent("atlas-0001")).toBe("u2");
    expect(late.service?.owners.agent("nobody-0001")).toBeNull();
  });

  it("builds the tunnels over the same runtime: a box that is not running answers box_stopped", async () => {
    const stopped = previewsLate({
      vm: {
        runtime: { phase: () => "stopped", link: () => undefined } as never,
        redact,
        hostsOf: () => null,
      },
      boxes: {
        workspace: { boxOps: () => projectOps, agentOps: () => agentOps, boxes: () => ({}) },
      } as never,
      sessions,
      m11: { platform, agents: { ownerOf: () => null } } as never,
    });
    await expect(
      stopped.service?.tunnels.open({ kind: "project", id: PROJECT }, "a".repeat(32)),
    ).rejects.toMatchObject({
      code: "box_stopped",
    });
  });
});
