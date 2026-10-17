import { PLATFORM_RESULTS, type SessionType } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDispatchBed, outcomes } from "../platform/testing/dispatch-bed.ts";
import { createNetworkRequest, NETWORK_REQUESTS_PER_HOUR } from "./ops-network.ts";

function setup() {
  const bed = createDispatchBed();
  const held = new Set<string>();
  const grants = {
    has: (sessionId: string, host: string) => held.has(`${sessionId}|${host}`),
    note: (sessionId: string, host: string) => void held.add(`${sessionId}|${host}`),
  };
  bed.port.register("network.request", createNetworkRequest({ grants, clock: bed.clock }));
  const ask = async (id: string, session = "t1", host = "api.example.com") => {
    bed.call(session, { id, op: "network.request", args: { host } });
    await bed.settle();
  };
  const granted = () =>
    bed.replies.map((reply) => (reply.ok ? (reply.result as { granted: boolean }).granted : reply.error));
  return { bed, grants, ask, granted };
}

describe("network.request (owner a2, M11R239)", () => {
  it("answers granted: false when the owner granted nothing, and true once the daemon holds the host", async () => {
    const { bed, grants, ask, granted } = setup();
    bed.session("t1");
    await ask("a");
    grants.note("t1", "api.example.com");
    await ask("b");
    await ask("c", "t1", "other.example.com");
    expect(granted()).toEqual([false, true, false]);
    expect(PLATFORM_RESULTS["network.request"].parse(bed.replies[1]?.result)).toEqual({ granted: true });
  });

  it("never answers true from another session's grant", async () => {
    const { bed, grants, ask, granted } = setup();
    bed.session("t1");
    bed.session("t2");
    grants.note("t2", "api.example.com");
    await ask("a", "t1");
    expect(granted()).toEqual([false]);
  });

  it.each<SessionType>(["agent-task", "child", "plain", "lane"])("is forbidden for a %s", async (type) => {
    const { bed, grants, ask } = setup();
    bed.session("t1", { type, agentId: type === "plain" || type === "lane" ? null : "atlas-0001" });
    grants.note("t1", "api.example.com");
    await ask("a");
    expect(outcomes(bed)).toEqual({ a: "forbidden" });
  });

  it("answers rate_limited for the 11th call in an hour, per thread, and works again an hour later", async () => {
    const { bed, ask, granted } = setup();
    bed.session("t1");
    bed.session("t2");
    for (let n = 0; n < NETWORK_REQUESTS_PER_HOUR; n++) await ask(`a${n}`);
    await ask("over");
    await ask("other", "t2");
    expect(NETWORK_REQUESTS_PER_HOUR).toBe(10);
    expect(granted().slice(-2)).toEqual(["rate_limited", false]);
    await bed.clock.advance(3_600_000);
    await ask("again");
    expect(granted().at(-1)).toBe(false);
  });
});
