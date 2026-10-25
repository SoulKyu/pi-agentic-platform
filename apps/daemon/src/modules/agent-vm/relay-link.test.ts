import { describe, expect, it, vi } from "vitest";
import type { PolicyView } from "./relay-link.ts";
import { bed, grant, POLICY, TOKEN } from "./testing/relay-link-bed.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-no-replay: nothing is replayed at `relay_ready` -> "replays every live grant, policy and the token" fails.
 *  - M-replay-revoked: `revoke` keeps the grant -> "does not replay a revoked grant" fails.
 *  - M-backoff: the delay stays 1 s (no doubling) / has no ceiling -> "restarts with 1 s doubling to 30 s" fails.
 *  - M-stale-policy: an older policy answer is sent after a newer one -> "sends the newest policy" fails.
 *  - M-early-fork: the child is forked before the bridge is up -> "starts after the bridge" fails.
 * (M-log-secret and M-mismatch moved with their tests to relay-link.log.test.ts.)
 */
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
        box: { kind: "agent", id: "scout-0001" },
        key: grant(1).relayKey,
        address: "10.213.0.2",
      },
      { type: "box_policy", box: { kind: "agent", id: "scout-0001" }, ...POLICY },
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

  it("pushes the empty policy at the agent's last revoke, not at another launch's (M3)", async () => {
    const { link, last, settle } = bed();
    await link.start();
    last().ready();
    link.grant(grant(1));
    link.grant(grant(2));
    await settle();
    link.revoke(grant(1).launchId);
    expect(last().sent.at(-1)).toMatchObject({ type: "relay_revoke" });
    link.revoke(grant(2).launchId);
    expect(last().sent.slice(-2)).toEqual([
      { type: "relay_revoke", launchId: grant(2).launchId },
      {
        type: "box_policy",
        box: { kind: "agent", id: "scout-0001" },
        models: [],
        claude: false,
        claudeToken: null,
        blocked: null,
      },
    ]);
  });

  it("drops an answer from before the last revoke, even after the agent launched again (M3, monotonic counter)", async () => {
    const slow: Array<(view: PolicyView) => void> = [];
    const policyOf = vi.fn(() => new Promise<PolicyView>((resolve) => slow.push(resolve)));
    const { link, last, settle } = bed({ policyOf });
    await link.start();
    last().ready();
    link.grant(grant(1));
    await settle();
    link.revoke(grant(1).launchId);
    link.grant(grant(2));
    await settle();
    slow[1]?.({ ...POLICY, blocked: "budget" });
    await settle();
    slow[0]?.({ ...POLICY, blocked: null });
    await settle();
    const policies = last().sent.filter(
      (m) =>
        (m as { type: string; models?: unknown[] }).type === "box_policy" &&
        (m as { models: unknown[] }).models.length > 0,
    );
    expect(policies).toEqual([
      { type: "box_policy", box: { kind: "agent", id: "scout-0001" }, ...POLICY, blocked: "budget" },
    ]);
  });

  it("pushes the policy again on each trigger: refresh, refresh of all, a token change (box_policy per live agent)", async () => {
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
    link.refresh({ kind: "agent", id: "scout-0001" });
    await settle();
    link.refreshAll();
    await settle();
    link.refresh({ kind: "agent", id: "never-launched" });
    await settle();
    const policies = last()
      .sent.filter((m) => (m as { type: string }).type === "box_policy")
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
    link.refresh({ kind: "agent", id: "scout-0001" });
    await settle();
    slow[1]?.({ ...POLICY, blocked: "budget" });
    await settle();
    slow[0]?.({ ...POLICY, blocked: null });
    await settle();
    const sent = last().sent.filter((m) => (m as { type: string }).type === "box_policy");
    expect(sent).toEqual([
      { type: "box_policy", box: { kind: "agent", id: "scout-0001" }, ...POLICY, blocked: "budget" },
    ]);
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
      type: "box_policy",
      box: { kind: "agent", id: "scout-0001" },
      models: [],
      claude: false,
      claudeToken: null,
      blocked: null,
    });
    expect(lines.some((line) => line.msg === "relay_policy_failed")).toBe(true);
  });

  it("pushes the Claude token inside the policy, and a revoked box leaves none behind", async () => {
    const { link, last, settle } = bed({ token: TOKEN });
    await link.start();
    last().ready();
    link.grant(grant(1));
    await settle();
    link.revoke(grant(1).launchId);
    const policies = (last().sent as Array<{ type: string; claudeToken?: string | null }>).filter(
      (m) => m.type === "box_policy",
    );
    expect(policies.map((m) => m.claudeToken)).toEqual([TOKEN, null]);
    expect((last().sent as Array<{ type: string }>).some((m) => m.type === "claude_token")).toBe(false);
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
      box?: { id: string };
      claudeToken?: string | null;
    }>;
    expect(replayed.filter((m) => m.type === "relay_grant").map((m) => m.launchId)).toEqual([
      grant(1).launchId,
      grant(2, "other-0002").launchId,
    ]);
    expect(
      replayed
        .filter((m) => m.type === "box_policy")
        .map((m) => m.box?.id)
        .sort(),
    ).toEqual(["other-0002", "scout-0001"]);
    expect(replayed.filter((m) => m.type === "box_policy").map((m) => m.claudeToken)).toEqual([TOKEN, TOKEN]);
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
