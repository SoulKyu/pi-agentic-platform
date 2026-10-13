import { describe, expect, it, vi } from "vitest";
import { maskedTextFrame, startWsServerForTest, upgradeRaw } from "./testing/raw-ws.ts";

describe("ws frame order", () => {
  it("enters the handlers of two frames sent in one TCP write in their order, before either answers", async () => {
    const entered: string[] = [];
    const gates: Array<() => void> = [];
    const server = await startWsServerForTest({
      dispatch: (frame) => {
        entered.push(frame.method);
        return new Promise((resolve) =>
          gates.push(() => resolve({ id: frame.id, ok: true, result: { ok: true } })),
        );
      },
    });
    const socket = await upgradeRaw(server.port, { Origin: server.origin, Cookie: server.cookie }).catch(
      async (error: unknown) => {
        await server.close();
        throw error;
      },
    );
    try {
      // Two masked client frames in a single write: the server reads them in one chunk.
      socket.write(
        Buffer.concat([
          maskedTextFrame(
            JSON.stringify({
              id: 1,
              method: "policy.revokeRule",
              params: { ruleId: "r" },
              commandId: "cmd-0000001",
            }),
          ),
          maskedTextFrame(
            JSON.stringify({
              id: 2,
              method: "sessions.prompt",
              params: { sessionId: "s", text: "x" },
              commandId: "cmd-0000002",
            }),
          ),
        ]),
      );
      await vi.waitFor(() => expect(entered).toEqual(["policy.revokeRule", "sessions.prompt"]), {
        timeout: 5_000,
      });
      for (const open of gates) open();
    } finally {
      socket.destroy();
      await server.close();
    }
  });
});
