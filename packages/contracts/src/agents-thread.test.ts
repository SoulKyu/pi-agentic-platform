import { describe, expect, it } from "vitest";
import {
  AGENT_GATE_ERRORS,
  AgentRequestView,
  AgentsStreamEvent,
  AgentSummary,
  agentInitials,
  methods,
  STREAMS,
  TOKEN_PERMISSIONS,
} from "./index.ts";

const summary = {
  id: "atlas-1a2b",
  name: "Atlas",
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
};
const request = {
  id: "r1",
  agentId: "atlas-1a2b",
  kind: "approve",
  title: "Deploy?",
  detail: null,
  createdAt: 1,
  expiresAt: 2,
};

describe("the agent thread methods (M11R59 to M11R63)", () => {
  it("openThread and markRead are agents:operate mutations a token may call; reset is browser-only", () => {
    for (const name of ["agents.openThread", "agents.markRead"] as const) {
      expect(methods[name]).toMatchObject({ permission: "agents:operate", idempotent: false });
    }
    expect(methods["agents.resetThread"]).toMatchObject({ permission: "agents:admin", idempotent: false });
    expect(TOKEN_PERMISSIONS).toContain("agents:operate");
    expect(TOKEN_PERMISSIONS).not.toContain("agents:admin");
  });

  it("openThread declares what a new thread's launch can refuse with", () => {
    expect(methods["agents.openThread"].errors).toEqual(
      expect.arrayContaining([
        "not_found",
        "session_busy",
        "capacity",
        "disk_low",
        "worker_failed",
        ...AGENT_GATE_ERRORS,
      ]),
    );
    expect(methods["agents.resetThread"].errors).toEqual(["not_found", "session_busy"]);
    expect(methods["agents.markRead"].errors).toEqual(["not_found"]);
  });

  it("subscribes with a cursor only: the stream is the caller's own", () => {
    expect(STREAMS).toContain("agents");
    expect(methods["subscribe.agents"]).toMatchObject({ permission: "agents:read", idempotent: true });
    expect(methods["subscribe.agents"].params.safeParse({ after: { epoch: "e", seq: 1 } }).success).toBe(
      true,
    );
    expect(methods["subscribe.agents"].params.safeParse({ agentId: "atlas-1a2b" }).success).toBe(false);
    expect(methods["agents.openThread"].params.safeParse({ agentId: "atlas-1a2b", extra: 1 }).success).toBe(
      false,
    );
    expect(methods["agents.openThread"].result.parse({ sessionId: "s1" })).toEqual({ sessionId: "s1" });
  });
});

describe("the agents stream events", () => {
  it("accepts the five events and refuses profile text on a summary", () => {
    expect(AgentSummary.safeParse(summary).success).toBe(true);
    expect(AgentSummary.safeParse({ ...summary, role: "secret" }).success).toBe(false);
    expect(AgentSummary.safeParse({ ...summary, state: "unreadable" }).success).toBe(false);
    expect(AgentSummary.safeParse({ ...summary, unread: 1_000_001 }).success).toBe(false);
    for (const event of [
      { kind: "snapshot", agents: [summary], requests: [request], truncated: false },
      { kind: "agent", agent: summary },
      { kind: "agent_removed", id: "atlas-1a2b" },
      { kind: "request", request },
      { kind: "request_closed", id: "r1" },
    ]) {
      expect(AgentsStreamEvent.safeParse(event).success).toBe(true);
    }
    expect(AgentsStreamEvent.safeParse({ kind: "other" }).success).toBe(false);
  });

  it("bounds the snapshot: 32 agents and 200 requests", () => {
    const snapshot = (agents: number, requests: number) =>
      AgentsStreamEvent.safeParse({
        kind: "snapshot",
        agents: Array.from({ length: agents }, () => summary),
        requests: Array.from({ length: requests }, () => request),
        truncated: false,
      }).success;
    expect(snapshot(32, 200)).toBe(true);
    expect(snapshot(33, 0)).toBe(false);
    expect(snapshot(0, 201)).toBe(false);
  });

  it("bounds a request's text", () => {
    expect(AgentRequestView.safeParse({ ...request, title: "x".repeat(501) }).success).toBe(false);
    expect(AgentRequestView.safeParse({ ...request, detail: "x".repeat(1001) }).success).toBe(false);
  });
});

describe("agentInitials", () => {
  it("uses the profile's own letters, else the first two letters or digits of the name", () => {
    expect(agentInitials("Atlas", "ZZ")).toBe("ZZ");
    expect(agentInitials("Atlas", undefined)).toBe("AT");
    expect(agentInitials("a", undefined)).toBe("A");
    expect(agentInitials("r2-d2", undefined)).toBe("R2");
    expect(agentInitials("Atlas", "not valid")).toBe("AT");
  });
});
