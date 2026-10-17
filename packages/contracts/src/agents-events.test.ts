import { describe, expect, it } from "vitest";
import {
  AgentEventView,
  AgentsStreamEvent,
  AgentStatus,
  methods,
  NotifyCardData,
  TOKEN_PERMISSIONS,
} from "./index.ts";

const AGENT = "atlas-1a2b";
const card = (kind: string, data: unknown, over: object = {}) => ({
  id: 1,
  kind,
  at: 5,
  taskId: null,
  data,
  ...over,
});

describe("the thread's cards (M11R72)", () => {
  it("reads each kind with its own data", () => {
    const ok = [
      card("schedule", { title: "Round", state: "running" }),
      card("task", { title: "Round", state: "done", durationMs: 3, costUsd: 0.1, billing: "api" }),
      card("isolated", {
        title: "Nightly",
        state: "failed",
        source: "webhook",
        tainted: true,
        scratch: "/pap/agents/.runs/a/b",
        summary: "x".repeat(2000),
        durationMs: null,
        costUsd: 0,
      }),
      card("delegation", {
        fromAgentId: "birch-3c4d",
        fromName: "Birch",
        state: "done",
        summary: "x".repeat(16_000),
        clipped: true,
        tainted: false,
        isolated: true,
      }),
      card("reminder", { note: "x".repeat(2000), setAt: 1 }),
      card("notify", { text: "x".repeat(500), itemId: "i1" }),
    ];
    for (const view of ok) expect(AgentEventView.safeParse(view).success).toBe(true);
  });

  it("refuses data of another kind, free text past its cap, extra keys and a kind it does not know", () => {
    const bad = [
      card("schedule", { note: "x", setAt: 1 }),
      card("task", { title: "", state: "done" }),
      card("task", { title: "T", state: "paused" }),
      card("task", { title: "T", state: "done", extra: 1 }),
      card("isolated", {
        title: "T",
        state: "done",
        source: "w",
        tainted: true,
        scratch: "/s",
        summary: "x".repeat(2001),
        durationMs: null,
        costUsd: 0,
      }),
      card("reminder", { note: "x".repeat(2001), setAt: 1 }),
      card("notify", { text: "x".repeat(501), itemId: "i" }),
      card("delegation", {
        fromAgentId: "../x",
        fromName: "B",
        state: "done",
        summary: "",
        clipped: false,
        tainted: false,
        isolated: false,
      }),
      card("memo", { text: "x" }),
      card("task", { title: "T", state: "done" }, { id: 0 }),
    ];
    for (const view of bad) expect(AgentEventView.safeParse(view).success).toBe(false);
  });

  it("refuses a notify card with an empty text or an empty item id", () => {
    expect(AgentEventView.safeParse(card("notify", { text: "", itemId: "i1" })).success).toBe(false);
    expect(AgentEventView.safeParse(card("notify", { text: "x", itemId: "" })).success).toBe(false);
    expect(NotifyCardData.safeParse({ text: "", itemId: "i1" }).success).toBe(false);
    expect(NotifyCardData.safeParse({ text: "x", itemId: "i1" }).success).toBe(true);
  });

  it("carries the hint on the agents stream", () => {
    expect(AgentsStreamEvent.safeParse({ kind: "event", agentId: AGENT, eventId: 3 }).success).toBe(true);
    expect(AgentsStreamEvent.safeParse({ kind: "event", agentId: "../x", eventId: 3 }).success).toBe(false);
    expect(AgentsStreamEvent.safeParse({ kind: "event", agentId: AGENT, eventId: 0 }).success).toBe(false);
  });
});

describe("the methods of Task 11", () => {
  it("declares the permission and the idempotence of each", () => {
    expect([methods["agents.events"].permission, methods["agents.events"].idempotent]).toEqual([
      "agents:read",
      true,
    ]);
    expect([methods["agents.status"].permission, methods["agents.status"].idempotent]).toEqual([
      "agents:read",
      true,
    ]);
    expect([methods["agents.setPaused"].permission, methods["agents.setPaused"].idempotent]).toEqual([
      "agents:operate",
      false,
    ]);
    expect([methods["agents.queueTask"].permission, methods["agents.queueTask"].idempotent]).toEqual([
      "agents:operate",
      false,
    ]);
    expect(TOKEN_PERMISSIONS).toContain("agents:operate");
  });

  it("decodes the events page request and refuses a cursor that is not at and id", () => {
    const { params } = methods["agents.events"];
    expect(params.safeParse({ agentId: AGENT }).success).toBe(true);
    expect(params.safeParse({ agentId: AGENT, before: { at: 5, id: 3 } }).success).toBe(true);
    expect(params.safeParse({ agentId: AGENT, before: { at: 5 } }).success).toBe(false);
    expect(params.safeParse({ agentId: AGENT, before: { at: 5, id: 0 } }).success).toBe(false);
    expect(params.safeParse({ agentId: AGENT, extra: 1 }).success).toBe(false);
  });

  it("caps a queued task's prompt and its hand-over at 20 000 characters", () => {
    const { params } = methods["agents.queueTask"];
    const handOff = { fromAgentId: "birch-3c4d", quote: "q" };
    expect(params.safeParse({ agentId: AGENT, prompt: "x".repeat(20_000), handOff }).success).toBe(true);
    expect(params.safeParse({ agentId: AGENT, prompt: "x".repeat(20_001) }).success).toBe(false);
    expect(params.safeParse({ agentId: AGENT, prompt: "" }).success).toBe(false);
    expect(
      params.safeParse({ agentId: AGENT, prompt: "x", handOff: { ...handOff, quote: "x".repeat(20_001) } })
        .success,
    ).toBe(false);
    expect(
      params.safeParse({ agentId: AGENT, prompt: "x", handOff: { fromAgentId: "../x", quote: "q" } }).success,
    ).toBe(false);
  });

  it("lets a caller handle the refusals the queue and the switch answer with", () => {
    expect(methods["agents.queueTask"].errors).toEqual(
      expect.arrayContaining(["forbidden", "agent_paused", "not_found", "rate_limited"]),
    );
    expect(methods["agents.setPaused"].errors).toEqual(
      expect.arrayContaining(["not_found", "conflict", "session_busy"]),
    );
  });

  it("shapes the status: the day against the budget, 7 and 30 days, the billing, at most 10 tasks and 20 triggers", () => {
    const status = {
      today: { usd: 0, tokens: 0, budgetUsd: null, budgetTokens: null },
      days7Usd: 0,
      days30Usd: 0,
      billing: "api",
      tasks: [],
      triggers: [],
      truncated: false,
    };
    expect(AgentStatus.safeParse(status).success).toBe(true);
    expect(AgentStatus.safeParse({ ...status, billing: "free" }).success).toBe(false);
    expect(AgentStatus.safeParse({ ...status, tasks: new Array(11).fill({}) }).success).toBe(false);
    expect(AgentStatus.safeParse({ ...status, triggers: new Array(21).fill({}) }).success).toBe(false);
  });
});
