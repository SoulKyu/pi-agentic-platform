import { AgentsStreamEvent } from "@pap/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { silentLogger } from "../../kernel/logger.ts";
import type { RunEndEvent, RunStartEvent } from "../runs/index.ts";
import type { AgentLinks } from "./links.ts";
import { createRequestViews } from "./requests-store.ts";
import { createAgentsStream, RAIL_EVERY_MS } from "./stream.ts";
import { agentInput, createAgentsBed, type AgentsBed } from "./testing/bed.ts";
import { bedHelpers } from "./testing/helpers.ts";
import { QUIET, type ThreadState } from "./testing/thread-bed.ts";

let bed: AgentsBed;
afterEach(() => bed.dispose());
const { insertRows } = bedHelpers(() => bed);

async function setup(links: AgentLinks = {}) {
  bed = createAgentsBed();
  const { id } = await bed.agents.create(bed.owner(), agentInput());
  const published: Array<{ stream: string; key: string; event: AgentsStreamEvent }> = [];
  let provider: ((key: string) => unknown) | null = null;
  const states = new Map<string, ThreadState>();
  const started: Array<(event: RunStartEvent) => void> = [];
  const ended: Array<(event: RunEndEvent) => void> = [];
  const attention: Array<(sessionId: string) => void> = [];
  const stream = createAgentsStream({
    store: bed.agents.store,
    requests: createRequestViews(bed.db),
    clock: bed.clock,
    logger: silentLogger,
    hub: {
      publish: (stream, key, event) =>
        void published.push({ stream, key, event: event as AgentsStreamEvent }),
      registerSnapshot: (_stream, fn) => void (provider = fn),
    },
    sessions: { threadState: (_owner, sessionId) => states.get(sessionId) ?? null },
    lastActivityAt: () => null,
    runs: {
      onRunStart: (listener) => (started.push(listener), () => void started.splice(0)),
      onRunEnd: (listener) => (ended.push(listener), () => void ended.splice(0)),
    },
    onAttention: (listener) => (attention.push(listener), () => void attention.splice(0)),
    links: () => links,
  });
  const snapshot = (ownerId = "u1") => AgentsStreamEvent.parse(provider?.(ownerId));
  const events = () => published.map((entry) => entry.event);
  const start = (sessionId: string) =>
    started.forEach((listener) =>
      listener({ runId: "r1", sessionId, ownerId: "u1", taskId: null, origin: "user" }),
    );
  const addRequest = (n: number, state = "pending", agentId = id) =>
    bed.db.run(
      `INSERT INTO agent_requests (id, agent_id, owner_id, session_id, kind, title, state, created_at, expires_at, answered_at)
       VALUES ($id, $agentId, 'u1', 't1', 'approve', 'Deploy?', $state, $at, $exp, $answered)`,
      {
        id: `req-${n}`,
        agentId,
        state,
        at: 1000 + n,
        exp: 9_999_999_999_999,
        answered: state === "pending" ? null : 5,
      },
    );
  return { id, stream, snapshot, events, published, states, start, attention, addRequest };
}

describe("the agents stream snapshot (M11R63)", () => {
  it("lists the owner's agents as summaries without any profile text", async () => {
    const { id, snapshot } = await setup();
    bed.db.run("UPDATE agents SET unread = 3");
    const first = snapshot();
    expect(first).toEqual({
      kind: "snapshot",
      agents: [
        {
          id,
          name: "Atlas",
          initials: "AT",
          state: "idle",
          unread: 3,
          paused: false,
          quarantined: false,
          unreadable: false,
          threadSessionId: null,
          lastActivityAt: bed.clock.now(),
        },
      ],
      requests: [],
      truncated: false,
    });
    expect(JSON.stringify(first)).not.toContain("role");
  });

  it("flags an agent whose stored profile does not parse: still listed, in the paused position", async () => {
    const { id, snapshot } = await setup();
    insertRows(1);
    const listed = snapshot();
    const agents = listed.kind === "snapshot" ? listed.agents : [];
    const good = agents.find((agent) => agent.id === id);
    const broken = agents.find((agent) => agent.id !== id);
    expect(good).toMatchObject({ id, unreadable: false, state: "idle" });
    expect(broken).toMatchObject({ unreadable: true, state: "paused", paused: false });
  });

  it("cannot hold a 33rd agent: 32 are listed and the next create is refused", async () => {
    const { snapshot } = await setup();
    insertRows(31);
    expect(
      await bedHelpers(() => bed).refusalOf(() =>
        bed.agents.create(bed.owner(), agentInput({ name: "Extra" })),
      ),
    ).toBe("limit_reached");
    const listed = snapshot();
    expect(listed.kind === "snapshot" && listed.agents).toHaveLength(32);
  });

  it("carries 200 pending requests at most and says truncated for the 201st", async () => {
    const { snapshot, addRequest } = await setup();
    for (let n = 0; n < 201; n += 1) addRequest(n);
    addRequest(500, "answered");
    const full = snapshot();
    expect(full.kind === "snapshot" && full.requests).toHaveLength(200);
    expect(full.kind === "snapshot" && full.requests[0]).toMatchObject({ id: "req-0", kind: "approve" });
    expect(full.kind === "snapshot" && full.truncated).toBe(true);
  });

  it("holds nothing of another owner's agents or requests", async () => {
    const { id, snapshot, addRequest } = await setup();
    addRequest(1);
    insertRows(1, "u2");
    bed.db.run(
      `INSERT INTO agent_requests (id, agent_id, owner_id, session_id, kind, title, state, created_at, expires_at)
       VALUES ('req-u2', 'bulk-0000', 'u2', 't2', 'approve', 'Mine?', 'pending', 1, 9999999999999)`,
    );
    const theirs = snapshot("u2");
    expect(theirs.kind === "snapshot" && theirs.agents.map((agent) => agent.id)).toEqual(["bulk-0000"]);
    expect(theirs.kind === "snapshot" && theirs.requests.map((request) => request.id)).toEqual(["req-u2"]);
    expect(JSON.stringify(theirs)).not.toContain(id);
    expect(JSON.stringify(theirs)).not.toContain("Deploy?");
    const mine = snapshot();
    expect(JSON.stringify(mine)).not.toContain("bulk-0000");
    expect(JSON.stringify(mine)).not.toContain("Mine?");
  });

  it("is not truncated with exactly 200 pending requests", async () => {
    const { snapshot, addRequest } = await setup();
    for (let n = 0; n < 200; n += 1) addRequest(n);
    const full = snapshot();
    expect(full.kind === "snapshot" && [full.requests.length, full.truncated]).toEqual([200, false]);
  });
});

describe("rail state facts (M11R62)", () => {
  it("reads the thread, the requests, the tasks and the cards, quarantined over all", async () => {
    const links: AgentLinks = {
      automation: { busy: vi.fn(() => false), deleteTriggersOf: vi.fn(), cancelQueuedOf: vi.fn() },
      rail: { failedCard: vi.fn(() => false), childWaiting: vi.fn(() => false) },
    };
    const { id, stream, states, addRequest } = await setup(links);
    const state = () => stream.state("u1", id);
    expect(state()).toBe("idle");
    bed.db.run("UPDATE agents SET thread_session_id = 't1'");
    states.set("t1", { ...QUIET, running: true });
    expect(state()).toBe("running");
    states.set("t1", { ...QUIET, starting: true });
    expect(state()).toBe("running");
    states.set("t1", { ...QUIET, running: true, needsInput: true });
    expect(state()).toBe("needs_input");
    states.set("t1", QUIET);
    addRequest(1);
    expect(state()).toBe("needs_input");
    bed.db.run("UPDATE agent_requests SET state = 'answered', answered_at = 5");
    expect(state()).toBe("idle");
    vi.mocked(links.automation?.busy as () => boolean).mockReturnValue(true);
    expect(state()).toBe("running");
    vi.mocked(links.automation?.busy as () => boolean).mockReturnValue(false);
    vi.mocked(links.rail?.failedCard as () => boolean).mockReturnValue(true);
    expect(state()).toBe("failed");
    vi.mocked(links.rail?.childWaiting as () => boolean).mockReturnValue(true);
    expect(state()).toBe("needs_input");
    bed.agents.setPaused("u1", id, true);
    vi.mocked(links.rail?.childWaiting as () => boolean).mockReturnValue(false);
    vi.mocked(links.rail?.failedCard as () => boolean).mockReturnValue(false);
    expect(state()).toBe("paused");
    bed.db.run("UPDATE agents SET quarantined_at = 1");
    states.set("t1", { ...QUIET, running: true, needsInput: true });
    expect(state()).toBe("quarantined");
    expect(stream.state("u2", id)).toBeNull();
  });

  it("a link that throws counts as no fact and is logged, never a failed snapshot", async () => {
    const links: AgentLinks = {
      rail: {
        failedCard: () => {
          throw new Error("boom");
        },
        childWaiting: () => false,
      },
    };
    const { id, stream, snapshot } = await setup(links);
    expect(stream.state("u1", id)).toBe("idle");
    expect(snapshot().kind).toBe("snapshot");
  });
});

describe("rail events (M11R62, throttled to 250 ms per owner)", () => {
  it("two changes within the window go out as one agent event with the final state", async () => {
    const { id, stream, events, states } = await setup();
    bed.db.run("UPDATE agents SET thread_session_id = 't1'");
    states.set("t1", { ...QUIET, running: true });
    stream.touch("u1", id);
    await bed.clock.advance(100);
    states.set("t1", { ...QUIET, running: true, needsInput: true });
    stream.touch("u1", id);
    await bed.clock.advance(RAIL_EVERY_MS - 101);
    expect(events()).toEqual([]);
    await bed.clock.advance(1);
    expect(events()).toEqual([
      { kind: "agent", agent: expect.objectContaining({ id, state: "needs_input", threadSessionId: "t1" }) },
    ]);
  });

  it("publishes nothing when the summary is as it was last sent, and one event per changed agent", async () => {
    const { id, stream, events } = await setup();
    stream.touch("u1", id);
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toHaveLength(1);
    stream.touch("u1", id);
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toHaveLength(1);
    bed.db.run("UPDATE agents SET unread = 2");
    stream.publish("u1");
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ kind: "agent", agent: { id, unread: 2 } });
  });

  it("tells a client that took a snapshot in the middle of an A to B to A change (the snapshot forgets what was sent)", async () => {
    const { id, stream, events, snapshot } = await setup();
    stream.touch("u1", id);
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toHaveLength(1);
    bed.db.run("UPDATE agents SET unread = 1");
    stream.touch("u1", id);
    const served = snapshot();
    expect(served.kind === "snapshot" && served.agents[0]?.unread).toBe(1);
    bed.db.run("UPDATE agents SET unread = 0");
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toHaveLength(2);
    expect(events()[1]).toMatchObject({ kind: "agent", agent: { id, unread: 0 } });
  });

  it("opens a new window after the batch went out", async () => {
    const { id, stream, events } = await setup();
    stream.touch("u1", id);
    await bed.clock.advance(RAIL_EVERY_MS);
    bed.db.run("UPDATE agents SET unread = 1");
    stream.touch("u1", id);
    await bed.clock.advance(RAIL_EVERY_MS - 1);
    expect(events()).toHaveLength(1);
    await bed.clock.advance(1);
    expect(events()).toHaveLength(2);
  });

  it("moves with the thread's runs and dialogs", async () => {
    const { id, events, states, start, attention } = await setup();
    bed.db.run("UPDATE agents SET thread_session_id = 't1'");
    states.set("t1", { ...QUIET, running: true });
    start("t1");
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events().at(-1)).toMatchObject({ agent: { id, state: "running" } });
    states.set("t1", { ...QUIET, running: true, needsInput: true });
    attention.forEach((listener) => listener("t1"));
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events().at(-1)).toMatchObject({ agent: { id, state: "needs_input" } });
    start("not-a-thread");
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toHaveLength(2);
  });

  it("tells a removal at once and forgets the agent's pending entry", async () => {
    const { id, stream, events } = await setup();
    stream.touch("u1", id);
    stream.registryChanged({ ownerId: "u1", agentId: id, removed: true });
    expect(events()).toEqual([{ kind: "agent_removed", id }]);
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events()).toEqual([{ kind: "agent_removed", id }]);
  });

  it("tells requests from their rows: open ones as request, closed or gone ones as request_closed", async () => {
    const { id, stream, events, addRequest } = await setup();
    addRequest(1);
    stream.requestChanged("u1", "req-1");
    expect(events()).toEqual([
      { kind: "request", request: expect.objectContaining({ id: "req-1", agentId: id, title: "Deploy?" }) },
    ]);
    bed.db.run("UPDATE agent_requests SET state = 'approved', answered_at = 9");
    stream.requestChanged("u1", "req-1");
    stream.requestChanged("u1", "req-gone");
    stream.requestChanged("u2", "req-1");
    expect(events().slice(1)).toEqual([
      { kind: "request_closed", id: "req-1" },
      { kind: "request_closed", id: "req-gone" },
      { kind: "request_closed", id: "req-1" },
    ]);
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events().filter((event) => event.kind === "agent")).toHaveLength(1);
  });

  it("stop ends the listening and drops the waiting batch", async () => {
    const { id, stream, events, start } = await setup();
    stream.touch("u1", id);
    stream.stop();
    await bed.clock.advance(RAIL_EVERY_MS);
    start("t1");
    expect(events()).toEqual([]);
    expect(bed.clock.pending()).toBe(0);
  });
});

describe("the card hint (M11R72)", () => {
  it("publishes an event hint at once, naming the agent and the card, and it parses on the wire", async () => {
    const { id, stream, events } = await setup();
    stream.eventWritten("u1", id, 7);
    expect(events()).toEqual([{ kind: "event", agentId: id, eventId: 7 }]);
    expect(AgentsStreamEvent.safeParse(events()[0]).success).toBe(true);
  });

  it("follows a card written beside the unread count: the hint at once, the rail's agent event with the next batch", async () => {
    const { id, stream, events } = await setup();
    stream.eventWritten("u1", id, 1);
    bed.db.run("UPDATE agents SET unread = 1");
    stream.touch("u1", id);
    expect(events().map((event) => event.kind)).toEqual(["event"]);
    await bed.clock.advance(RAIL_EVERY_MS);
    expect(events().map((event) => event.kind)).toEqual(["event", "agent"]);
  });

  it("puts the red dot on the rail from the card link", async () => {
    const { id, snapshot } = await setup({
      rail: { failedCard: (_owner, agentId) => agentId !== "", childWaiting: () => false },
    });
    const first = snapshot();
    expect(first.kind === "snapshot" && first.agents[0]?.state).toBe("failed");
    expect(id).toBeTruthy();
  });
});
