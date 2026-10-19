import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createFakeClock } from "../../kernel/clock.ts";
import { captureLogger } from "../../testing/capture-logger.ts";
import { createRelayLink, type PolicyView, type RelayChild } from "./relay-link.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-no-replay: nothing is replayed at `relay_ready` -> "replays every live grant, policy and the token" fails.
 *  - M-replay-revoked: `revoke` keeps the grant -> "does not replay a revoked grant" fails.
 *  - M-backoff: the delay stays 1 s (no doubling) / has no ceiling -> "restarts with 1 s doubling to 30 s" fails.
 *  - M-stale-policy: an older policy answer is sent after a newer one -> "sends the newest policy" fails.
 *  - M-log-secret: a log line carries the relay key or the Claude token -> "no secret in a log line" fails.
 *  - M-early-fork: the child is forked before the bridge is up -> "starts after the bridge" fails.
 *  - M-mismatch: the threshold is dropped -> "logs a mismatch only when" fails.
 */
const KEY = "ab".repeat(32);
const TOKEN = "sk-ant-oat01-OWNER-TOKEN-0123456789";
const grant = (n: number, agentId = "scout-0001") => ({
  launchId: String(n).repeat(32).slice(0, 32),
  agentId,
  relayKey: String(n)
    .repeat(64)
    .slice(0, 64)
    .replace(/[^0-9a-f]/g, "a"),
  address: "10.213.0.2",
});
const POLICY: PolicyView = { models: [{ provider: "acme", id: "m-1" }], claude: false, blocked: null };

class FakeChild extends EventEmitter implements RelayChild {
  readonly sent: unknown[] = [];
  killed = false;
  send(message: unknown): boolean {
    this.sent.push(message);
    return true;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  ready(): void {
    this.emit("message", { type: "relay_ready", port: 7842 });
  }
  die(): void {
    this.emit("exit", 1, null);
  }
  types(): string[] {
    return this.sent.map((message) => (message as { type: string }).type);
  }
}

function bed(
  over: {
    policyOf?: (agentId: string) => Promise<PolicyView>;
    token?: string | null;
    bridgeReady?: () => Promise<void>;
    runs?: (agentId: string) => number;
  } = {},
) {
  const clock = createFakeClock();
  const { logger, lines } = captureLogger();
  const children: FakeChild[] = [];
  const forks = vi.fn(() => {
    const child = new FakeChild();
    children.push(child);
    return child;
  });
  const link = createRelayLink({
    fork: forks,
    clock,
    logger,
    policyOf: over.policyOf ?? (async () => POLICY),
    claudeToken: () => (over.token === undefined ? null : over.token),
    ...(over.bridgeReady ? { bridgeReady: over.bridgeReady } : {}),
    ...(over.runs ? { reportedRuns: over.runs } : {}),
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    clock,
    lines,
    children,
    forks,
    link,
    settle,
    last: () => children[children.length - 1] as FakeChild,
  };
}

describe("the relay link: grants and policy", () => {
  it("sends a grant and then the agent's policy once the child is ready", async () => {
    const { link, last, settle } = bed();
    await link.start();
    last().ready();
    link.grant(grant(1));
    await settle();
    expect(last().sent).toEqual([
      {
        type: "relay_grant",
        launchId: grant(1).launchId,
        agentId: "scout-0001",
        key: grant(1).relayKey,
        address: "10.213.0.2",
      },
      { type: "agent_policy", agentId: "scout-0001", ...POLICY },
    ]);
  });

  it("sends a revoke, and the agent's other launches stay", async () => {
    const { link, last, settle } = bed();
    await link.start();
    last().ready();
    link.grant(grant(1));
    link.grant(grant(2));
    await settle();
    link.revoke(grant(1).launchId);
    expect(last().sent.at(-1)).toEqual({ type: "relay_revoke", launchId: grant(1).launchId });
  });

  it("pushes the policy again on each trigger: refresh, refresh of all, a token change (agent_policy per live agent)", async () => {
    const answers: PolicyView[] = [
      POLICY,
      { ...POLICY, blocked: "paused" },
      { ...POLICY, blocked: "budget" },
      { ...POLICY, blocked: null },
    ];
    const policyOf = vi.fn(async () => answers.shift() ?? POLICY);
    const { link, last, settle } = bed({ policyOf });
    await link.start();
    last().ready();
    link.grant(grant(1));
    await settle();
    link.refresh("scout-0001");
    await settle();
    link.refreshAll();
    await settle();
    link.refresh("never-launched");
    await settle();
    const policies = last()
      .sent.filter((m) => (m as { type: string }).type === "agent_policy")
      .map((m) => (m as { blocked: string | null }).blocked);
    expect(policies).toEqual([null, "paused", "budget"]);
    expect(policyOf).toHaveBeenCalledTimes(3);
  });

  it("sends the newest policy when answers come back out of order (M-stale-policy)", async () => {
    const slow: Array<(view: PolicyView) => void> = [];
    const policyOf = vi.fn(() => new Promise<PolicyView>((resolve) => slow.push(resolve)));
    const { link, last, settle } = bed({ policyOf });
    await link.start();
    last().ready();
    link.grant(grant(1));
    link.refresh("scout-0001");
    await settle();
    slow[1]?.({ ...POLICY, blocked: "budget" });
    await settle();
    slow[0]?.({ ...POLICY, blocked: null });
    await settle();
    const sent = last().sent.filter((m) => (m as { type: string }).type === "agent_policy");
    expect(sent).toEqual([{ type: "agent_policy", agentId: "scout-0001", ...POLICY, blocked: "budget" }]);
  });

  it("fails closed when the policy cannot be read: the agent is told it may use nothing", async () => {
    const policyOf = vi.fn(async () => {
      throw new Error("helper down");
    });
    const { link, last, settle, lines } = bed({ policyOf });
    await link.start();
    last().ready();
    link.grant(grant(1));
    await settle();
    expect(last().sent.at(-1)).toEqual({
      type: "agent_policy",
      agentId: "scout-0001",
      models: [],
      claude: false,
      blocked: null,
    });
    expect(lines.some((line) => line.msg === "relay_policy_failed")).toBe(true);
  });

  it("pushes the Claude token and its removal", async () => {
    const { link, last } = bed();
    await link.start();
    last().ready();
    link.setClaudeToken(TOKEN);
    link.setClaudeToken(null);
    expect(last().sent).toEqual([
      { type: "claude_token", token: TOKEN },
      { type: "claude_token", token: null },
    ]);
  });
});

describe("the relay link: where it listens", () => {
  it("knows the ready child's port, and none while it is down", async () => {
    const { link, last, children, clock } = bed();
    await link.start();
    expect(link.port()).toBeNull();
    last().ready();
    expect(link.port()).toBe(7842);
    children[0]?.die();
    expect(link.port()).toBeNull();
    await clock.advance(1000);
    expect(link.port()).toBeNull();
  });
});

describe("the relay link: a restart (RT-36)", () => {
  it("replays every live grant, policy and the token after a restart (M-no-replay)", async () => {
    const { link, last, children, clock, settle } = bed({ token: TOKEN });
    await link.start();
    last().ready();
    link.grant(grant(1));
    link.grant(grant(2, "other-0002"));
    await settle();
    children[0]?.die();
    await clock.advance(1000);
    expect(children).toHaveLength(2);
    last().ready();
    await settle();
    const replayed = last().sent as Array<{
      type: string;
      launchId?: string;
      agentId?: string;
      token?: string;
    }>;
    expect(replayed.filter((m) => m.type === "relay_grant").map((m) => m.launchId)).toEqual([
      grant(1).launchId,
      grant(2, "other-0002").launchId,
    ]);
    expect(
      replayed
        .filter((m) => m.type === "agent_policy")
        .map((m) => m.agentId)
        .sort(),
    ).toEqual(["other-0002", "scout-0001"]);
    expect(replayed.find((m) => m.type === "claude_token")?.token).toBe(TOKEN);
  });

  it("does not replay a revoked grant (M-replay-revoked)", async () => {
    const { link, last, children, clock, settle } = bed();
    await link.start();
    last().ready();
    link.grant(grant(1));
    link.grant(grant(2));
    await settle();
    link.revoke(grant(1).launchId);
    children[0]?.die();
    await clock.advance(1000);
    last().ready();
    await settle();
    const grants = last().sent.filter((m) => (m as { type: string }).type === "relay_grant");
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ launchId: grant(2).launchId });
  });

  it("restarts with 1 s doubling to 30 s, and starts again from 1 s after a long life (M-backoff)", async () => {
    const { link, children, clock } = bed();
    await link.start();
    const waits: number[] = [];
    for (const expected of [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000]) {
      const before = children.length;
      children.at(-1)?.die();
      await clock.advance(expected - 1);
      expect(children.length, `no restart before ${expected} ms`).toBe(before);
      await clock.advance(1);
      expect(children.length, `a restart at ${expected} ms`).toBe(before + 1);
      waits.push(expected);
    }
    // A child that was ready for a minute is not a crash loop: the next wait is 1 s again.
    children.at(-1)?.ready();
    await clock.advance(61_000);
    children.at(-1)?.die();
    const before = children.length;
    await clock.advance(1000);
    expect(children.length).toBe(before + 1);
    expect(waits).toHaveLength(7);
  });

  it("does not restart after stop", async () => {
    const { link, children, clock } = bed();
    await link.start();
    link.stop();
    expect(children[0]?.killed).toBe(true);
    children[0]?.die();
    await clock.advance(60_000);
    expect(children).toHaveLength(1);
  });
});

describe("the relay link: when it starts (AVM-P10)", () => {
  it("starts after the bridge (M-early-fork)", async () => {
    let up: () => void = () => {};
    const bridge = new Promise<void>((resolve) => {
      up = resolve;
    });
    const { link, forks, settle } = bed({ bridgeReady: () => bridge });
    const started = link.start();
    await settle();
    expect(forks).not.toHaveBeenCalled();
    up();
    await started;
    expect(forks).toHaveBeenCalledTimes(1);
  });
});

describe("the relay link: what it logs", () => {
  it("logs each relay_usage and a mismatch only when the relay's requests exceed the runs by more than 10 (M-mismatch)", async () => {
    const runs = new Map([
      ["scout-0001", 5],
      ["busy-0002", 5],
    ]);
    const { link, last, lines } = bed({ runs: (agentId) => runs.get(agentId) ?? 0 });
    await link.start();
    last().ready();
    last().emit("message", {
      type: "relay_usage",
      agents: [
        { agentId: "scout-0001", requests: 15, refused: 1, bytesIn: 10, bytesOut: 20 },
        { agentId: "busy-0002", requests: 16, refused: 0, bytesIn: 1, bytesOut: 2 },
      ],
    });
    const usage = lines.filter((line) => line.msg === "agent_relay_usage");
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ agentId: "scout-0001", requests: 15, refused: 1 });
    const mismatches = lines.filter((line) => line.msg === "agent_relay_mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ agentId: "busy-0002" });
  });

  it("no secret in a log line (M-log-secret)", async () => {
    const { link, last, lines, children, clock, settle } = bed({ token: TOKEN });
    await link.start();
    last().ready();
    link.grant(grant(1));
    link.setClaudeToken(TOKEN);
    await settle();
    // A malformed report and a child that prints a key on stderr never reach the log.
    last().emit("message", { type: "relay_usage", agents: "no", key: KEY });
    last().emit("message", { token: TOKEN });
    children[0]?.die();
    await clock.advance(1000);
    last().ready();
    await settle();
    const text = JSON.stringify(lines);
    expect(text).not.toContain(grant(1).relayKey);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(KEY);
    expect(lines.length).toBeGreaterThan(0);
  });
});
