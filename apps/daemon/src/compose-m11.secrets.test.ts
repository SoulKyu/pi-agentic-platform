import { afterEach, describe, expect, it } from "vitest";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

const portsOf = (sessions: ReturnType<typeof parts>["sessions"]) =>
  sessions.setAgentPorts.mock.calls.map((call) => call[0] as Record<string, unknown>);

describe("secret requests in the composed entry (Task 18)", () => {
  it("gives the sessions module the use-once lookups, bound once", () => {
    const { sessions } = parts();
    const agents = portsOf(sessions).find((ports) => "agents" in ports)?.agents as {
      onceOf(sessionId: string): unknown;
      onceUsed(sessionId: string, name: string): void;
    };
    expect(agents.onceOf("s1")).toEqual([]);
    expect(() => agents.onceUsed("s1", "API_TOKEN")).not.toThrow();
  });

  it("serves the answer and the decline: a token is forbidden, an unknown request not_found", async () => {
    const { m11 } = parts();
    const token = { caller: testCaller({ kind: "token" }) } as never;
    const owner = { caller: testCaller() } as never;
    const params = { requestId: "nope", value: "v", mode: "once" } as const;
    await expect(m11.rpc["secrets.answerRequest"](params, token)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(m11.rpc["secrets.declineRequest"]({ requestId: "nope" }, token)).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(m11.rpc["secrets.answerRequest"](params, owner)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(m11.rpc["secrets.declineRequest"]({ requestId: "nope" }, owner)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});
