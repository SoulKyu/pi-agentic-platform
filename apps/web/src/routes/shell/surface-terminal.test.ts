import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Runtime } from "../../runtime/index.ts";
import { useTerminalStore } from "../../stores/terminal-store.ts";
import { rememberedRequests, terminalFor } from "./surface-terminal.ts";
import { useTerminalReady } from "./surface-view.ts";

const calls = vi.hoisted(() => [] as Array<{ requestId: string; sessionId: string }>);
vi.mock("../../runtime/index.ts", async (original) => ({
  ...(await original<typeof import("../../runtime/index.ts")>()),
  getRuntime: () =>
    ({
      rpc: {
        call: async (_method: string, params: { requestId: string; sessionId: string }) => {
          calls.push(params);
          throw new (await import("../../runtime/index.ts")).RpcError("connection_lost");
        },
      },
    }) as unknown as Runtime,
}));

beforeEach(() => {
  calls.length = 0;
  useTerminalStore.getState().reset();
  useTerminalReady.getState().set(true);
});

describe("terminalFor request ids of unknown outcome", () => {
  it("remembers at most 32 sessions: past the cap a retry gets a fresh id", async () => {
    for (let i = 0; i < 40; i += 1) expect(await terminalFor(`s${i}`, "/w")).toBeNull();
    expect(rememberedRequests()).toBe(32);
    const first = calls.filter((one) => one.sessionId === "s0")[0]?.requestId;
    const last = calls.filter((one) => one.sessionId === "s39")[0]?.requestId;
    await terminalFor("s0", "/w");
    await terminalFor("s39", "/w");
    expect(calls.filter((one) => one.sessionId === "s0")[1]?.requestId).toBe(first);
    expect(calls.filter((one) => one.sessionId === "s39")[1]?.requestId).not.toBe(last);
  });

  it("creates nothing while the stream has not answered", async () => {
    useTerminalReady.getState().set(false);
    expect(await terminalFor("early", "/w")).toBeNull();
    expect(calls).toEqual([]);
  });
});
