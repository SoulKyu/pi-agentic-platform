import type { VaultUpdateRecord } from "@pap/contracts";
import { describe, expect, it, vi } from "vitest";
import { captureLogger } from "../../testing/capture-logger.ts";
import { type AgentPortContext, createAgentPort } from "./agent-port.ts";

const RECORD: VaultUpdateRecord = { type: "vault_update", vault: { API_TOKEN: "v" }, once: [] };
const ROW = { id: "s1", ownerId: "u1", agentId: "atlas-1a2b", agentRole: "thread" };

function setup(session: { send: () => boolean; stop: () => Promise<void> }) {
  const { logger, lines } = captureLogger();
  const live = new Map([["s1", { status: () => "idle", stopping: () => false, ...session }]]);
  const port = createAgentPort({
    deps: { store: { get: () => ROW }, logger },
    live,
    agent: { sandboxed: () => true, onceOf: () => [], vmLayoutOf: () => null },
  } as unknown as AgentPortContext);
  return { port, lines };
}

describe("sendToAgent when a worker cannot be told (M11R86)", () => {
  it("stops that worker, so its next start reads the current vault, and does not count it as told", () => {
    const stop = vi.fn(async () => {});
    const { port } = setup({ send: () => false, stop });
    expect(port.sendToAgent("u1", "atlas-1a2b", RECORD)).toBe(0);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("logs a stop that fails, with no value in the line", async () => {
    const { port, lines } = setup({
      send: () => false,
      stop: () => Promise.reject(new Error("stuck")),
    });
    expect(port.sendToAgent("u1", "atlas-1a2b", RECORD)).toBe(0);
    await vi.waitFor(
      () =>
        expect(lines.find((line) => line["msg"] === "vault_update_stop_failed")).toMatchObject({
          level: "warn",
          sessionId: "s1",
        }),
      { timeout: 5000 },
    );
    expect(JSON.stringify(lines)).not.toContain("API_TOKEN");
  });

  it("does not stop a worker that was told", () => {
    const stop = vi.fn(async () => {});
    const { port } = setup({ send: () => true, stop });
    expect(port.sendToAgent("u1", "atlas-1a2b", RECORD)).toBe(1);
    expect(stop).not.toHaveBeenCalled();
  });
});
