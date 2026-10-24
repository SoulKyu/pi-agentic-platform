import { AGENT_LIMITS, PLATFORM_RESULTS, type SessionType } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { createDispatchBed, outcomes } from "../platform/testing/dispatch-bed.ts";
import { createNetworkRequest, NETWORK_REQUESTS_PER_HOUR } from "./ops-network.ts";

const BOX = { hosts: [] as readonly string[] };

function setup(box: { hosts: readonly string[] } | null = null) {
  const bed = createDispatchBed();
  const held = new Set<string>();
  const grants = {
    has: (sessionId: string, host: string) => held.has(`${sessionId}|${host}`),
    note: (sessionId: string, host: string) => void held.add(`${sessionId}|${host}`),
  };
  bed.port.register(
    "network.request",
    createNetworkRequest({
      grants,
      clock: bed.clock,
      boxOf: (sessionId) => (sessionId.startsWith("box-") ? box : null),
    }),
  );
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

  describe("in a project's box (task A7)", () => {
    it.each<[SessionType, string | null]>([
      ["plain", null],
      ["task", null],
      ["child", null],
    ])("answers a %s session of a box from the daemon's grant record", async (type, agentId) => {
      const { bed, grants, ask, granted } = setup(BOX);
      bed.session("box-1", { type, agentId });
      await ask("a", "box-1");
      grants.note("box-1", "api.example.com");
      await ask("b", "box-1");
      expect(granted()).toEqual([false, true]);
    });

    it("a host session's network.request is forbidden, grant or not", async () => {
      const { bed, grants, ask } = setup(BOX);
      for (const type of ["plain", "task"] as const) {
        bed.session(`${type}-host`, { type, agentId: null });
        grants.note(`${type}-host`, "api.example.com");
        await ask(`${type}`, `${type}-host`);
      }
      expect(outcomes(bed)).toEqual({ plain: "forbidden", task: "forbidden" });
    });

    it("an unattended task's request holds no grant until the owner answers, and a timeout leaves it so", async () => {
      const { bed, ask, granted } = setup(BOX);
      bed.session("box-task", { type: "task", agentId: null });
      await ask("a", "box-task");
      await bed.clock.advance(30 * 60_000);
      await ask("b", "box-task");
      expect(granted()).toEqual([false, false]);
    });

    it("answers limit_reached when the project's list is full and the host is not on it", async () => {
      const full = { hosts: Array.from({ length: AGENT_LIMITS.hosts }, (_, n) => `h${n}.example.com`) };
      const { bed, ask } = setup(full);
      bed.session("box-1", { type: "plain", agentId: null });
      await ask("a", "box-1");
      await ask("b", "box-1", "h3.example.com");
      expect(outcomes(bed)).toEqual({ a: "limit_reached", b: "ok" });
    });

    it("keeps the limit of 10 an hour per session", async () => {
      const { bed, ask, granted } = setup(BOX);
      bed.session("box-1", { type: "plain", agentId: null });
      for (let n = 0; n < NETWORK_REQUESTS_PER_HOUR; n++) await ask(`a${n}`, "box-1");
      await ask("over", "box-1");
      expect(granted().at(-1)).toBe("rate_limited");
    });
  });
});
