import { afterEach, describe, expect, it } from "vitest";
import type { PlatformPort } from "./modules/platform/index.ts";
import { testCaller } from "./testing/caller.ts";
import { disposeParts, parts } from "./testing/compose-m11-parts.ts";

afterEach(disposeParts);

const insertAgent = (db: ReturnType<typeof parts>["db"]) =>
  db.run(
    `INSERT INTO agents (id, owner_id, name, name_key, profile, created_at, updated_at)
     VALUES ('atlas-0001', 'u1', 'Atlas', 'atlas', '{"name":"Atlas"}', 1, 1)`,
  );
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

  it("answers sandbox_unavailable on a host with no usable bwrap, and opens no request", async () => {
    const { sessions, db, clock, agentItems } = parts();
    insertAgent(db);
    const platform = portsOf(sessions)[0]?.platform as PlatformPort;
    const replies: unknown[] = [];
    platform.onRecord(
      { id: "s1", ownerId: "u1" },
      {
        type: "platform_call",
        id: "p1",
        op: "secret.request",
        toolCallId: "t",
        args: { name: "GRAFANA_TOKEN", reason: "dashboards" },
      },
      (record) => replies.push(record),
    );
    await clock.advance(0);
    await clock.advance(0);
    expect(replies).toEqual([{ type: "platform_result", id: "p1", ok: false, error: "sandbox_unavailable" }]);
    expect(db.all("SELECT id FROM agent_requests")).toEqual([]);
    expect(agentItems.upsertAgentItem).not.toHaveBeenCalled();
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
