import { AGENTS_STREAM_LIMITS, type AgentRequestView, type AgentSummary } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { agentById, EMPTY_AGENTS, reduceAgents, requestsOf } from "./agents-reducer.ts";

const agent = (id: string, patch: Partial<AgentSummary> = {}): AgentSummary => ({
  id,
  name: id.split("-")[0] ?? id,
  initials: "AT",
  state: "idle",
  unread: 0,
  paused: false,
  quarantined: false,
  unreadable: false,
  threadSessionId: null,
  lastActivityAt: 1,
  ...patch,
});
const request = (
  id: string,
  agentId = "atlas-1a2b",
  patch: Partial<AgentRequestView> = {},
): AgentRequestView => ({
  id,
  agentId,
  kind: "approve",
  title: "Deploy?",
  detail: null,
  createdAt: 1,
  expiresAt: 2,
  ...patch,
});
const snapshot = (agents: AgentSummary[], requests: AgentRequestView[] = [], truncated = false) => ({
  kind: "snapshot",
  agents,
  requests,
  truncated,
});
const ids = (view: { agents: readonly AgentSummary[] }) => view.agents.map((one) => one.id);

describe("the agents reducer (M11R63)", () => {
  it("starts empty and not loaded", () => {
    expect(EMPTY_AGENTS).toMatchObject({
      loaded: false,
      agents: [],
      requests: [],
      truncated: false,
      failed: null,
    });
  });

  it("takes a snapshot: agents, requests, truncated and the loaded flag, and clears a failure", () => {
    const failed = { ...EMPTY_AGENTS, failed: "capacity" as const };
    const view = reduceAgents(failed, snapshot([agent("atlas-1a2b")], [request("r1")], true));
    expect(view).toMatchObject({ loaded: true, truncated: true, failed: null });
    expect(ids(view)).toEqual(["atlas-1a2b"]);
    expect(view.requests.map((one) => one.id)).toEqual(["r1"]);
  });

  it("replaces an agent in place on an agent event and appends a new one", () => {
    let view = reduceAgents(EMPTY_AGENTS, snapshot([agent("atlas-1a2b"), agent("bolt-0001")]));
    view = reduceAgents(view, { kind: "agent", agent: agent("atlas-1a2b", { state: "running", unread: 2 }) });
    expect(ids(view)).toEqual(["atlas-1a2b", "bolt-0001"]);
    expect(agentById(view, "atlas-1a2b")).toMatchObject({ state: "running", unread: 2 });
    view = reduceAgents(view, { kind: "agent", agent: agent("cleo-0002") });
    expect(ids(view)).toEqual(["atlas-1a2b", "bolt-0001", "cleo-0002"]);
  });

  it("drops an agent and its requests on agent_removed", () => {
    let view = reduceAgents(
      EMPTY_AGENTS,
      snapshot([agent("atlas-1a2b"), agent("bolt-0001")], [request("r1"), request("r2", "bolt-0001")]),
    );
    view = reduceAgents(view, { kind: "agent_removed", id: "atlas-1a2b" });
    expect(ids(view)).toEqual(["bolt-0001"]);
    expect(requestsOf(view, "atlas-1a2b")).toEqual([]);
    expect(requestsOf(view, "bolt-0001").map((one) => one.id)).toEqual(["r2"]);
  });

  it("upserts a request by id and closes it by id", () => {
    let view = reduceAgents(EMPTY_AGENTS, snapshot([agent("atlas-1a2b")]));
    view = reduceAgents(view, { kind: "request", request: request("r1") });
    view = reduceAgents(view, { kind: "request", request: request("r1", "atlas-1a2b", { title: "Again?" }) });
    expect(view.requests).toHaveLength(1);
    expect(view.requests[0]?.title).toBe("Again?");
    view = reduceAgents(view, { kind: "request_closed", id: "r1" });
    expect(view.requests).toEqual([]);
    expect(reduceAgents(view, { kind: "request_closed", id: "r9" })).toBe(view);
  });

  it("keeps at most 200 requests: a new one past the cap is left out and the view says truncated", () => {
    const full = Array.from({ length: AGENTS_STREAM_LIMITS.requests }, (_, n) => request(`r${n}`));
    let view = reduceAgents(EMPTY_AGENTS, snapshot([agent("atlas-1a2b")], full));
    expect(view.truncated).toBe(false);
    view = reduceAgents(view, { kind: "request", request: request("extra") });
    expect(view.requests).toHaveLength(AGENTS_STREAM_LIMITS.requests);
    expect(view.requests.some((one) => one.id === "extra")).toBe(false);
    expect(view.truncated).toBe(true);
    // An update of one it already holds still goes in.
    view = reduceAgents(view, {
      kind: "request",
      request: request("r3", "atlas-1a2b", { title: "Changed" }),
    });
    expect(view.requests.find((one) => one.id === "r3")?.title).toBe("Changed");
  });

  it("keeps at most 32 agents: a 33rd is left out and counted as skipped", () => {
    const full = Array.from({ length: 32 }, (_, n) => agent(`a${n}-0000`));
    let view = reduceAgents(EMPTY_AGENTS, snapshot(full));
    view = reduceAgents(view, { kind: "agent", agent: agent("extra-0000") });
    expect(view.agents).toHaveLength(32);
    expect(view.skipped).toBe(1);
  });

  it("skips an event it cannot read instead of failing", () => {
    const view = reduceAgents(EMPTY_AGENTS, { kind: "future" });
    expect(view).toEqual({ ...EMPTY_AGENTS, skipped: 1 });
    expect(reduceAgents(view, { kind: "agent", agent: { id: "x" } }).skipped).toBe(2);
  });

  it("counts the cards written for a listed agent so its open tab reads them again, and forgets a removed agent", () => {
    const listed = reduceAgents(EMPTY_AGENTS, snapshot([agent("atlas-1a2b")]));
    const one = reduceAgents(listed, { kind: "event", agentId: "atlas-1a2b", eventId: 4 });
    const two = reduceAgents(one, { kind: "event", agentId: "atlas-1a2b", eventId: 4 });
    expect(two.cardTicks).toEqual({ "atlas-1a2b": 2 });
    expect(reduceAgents(two, snapshot([agent("atlas-1a2b")])).cardTicks).toEqual({ "atlas-1a2b": 2 });
    expect(reduceAgents(listed, { kind: "event", agentId: "ghost-9a9b", eventId: 1 })).toBe(listed);
    expect(reduceAgents(two, { kind: "agent_removed", id: "atlas-1a2b" }).cardTicks).toEqual({});
  });
});
