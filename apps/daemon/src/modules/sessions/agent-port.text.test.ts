import { describe, expect, it, vi } from "vitest";
import { createAgentPort } from "./agent-port.ts";

function port(options: { owner?: string; agentId?: string | undefined } = {}) {
  const agentText = vi.fn<(sessionId: string, max: number, since?: number) => Promise<string>>(
    async () => "last words",
  );
  const row = { id: "s1", ownerId: options.owner ?? "u1", agentId: options.agentId ?? "atlas-1a2b" };
  const value = createAgentPort({
    deps: { store: { get: (id: string) => (id === "s1" ? row : undefined) } },
    lastText: agentText,
  } as never);
  return { value, agentText };
}

describe("lastText (M11R69)", () => {
  it("reads the last assistant text of an agent's session, cut to the length asked", async () => {
    const { value, agentText } = port();
    expect(await value.lastText("u1", "s1", 2_000)).toBe("last words");
    expect(agentText).toHaveBeenCalledWith("s1", 2_000, undefined);
  });

  it("passes the time an answer must not be older than", async () => {
    const { value, agentText } = port();
    await value.lastText("u1", "s1", 10, 500);
    expect(agentText).toHaveBeenCalledWith("s1", 10, 500);
  });

  it("answers null for another owner's session, a session that is no agent's, and one that is gone", async () => {
    expect(await port({ owner: "u2" }).value.lastText("u1", "s1", 10)).toBeNull();
    const plain = port({ agentId: undefined });
    plain.agentText.mockClear();
    const noAgent = createAgentPort({
      deps: { store: { get: () => ({ id: "s1", ownerId: "u1" }) } },
      lastText: plain.agentText,
    } as never);
    expect(await noAgent.lastText("u1", "s1", 10)).toBeNull();
    expect(plain.agentText).not.toHaveBeenCalled();
    expect(await port().value.lastText("u1", "gone", 10)).toBeNull();
  });
});
