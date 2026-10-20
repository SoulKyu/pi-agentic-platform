import { describe, expect, it, vi } from "vitest";
import { bed, grant, KEY, TOKEN } from "./testing/relay-link-bed.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-mismatch: the threshold is dropped -> "logs a mismatch once when" fails; the turns not read -> "no mismatch while" fails.
 *  - M-window: the window's end is not told -> "tells the composition each window ended" fails.
 *  - M-log-secret: a log line carries the relay key or the Claude token -> "no secret in a log line" fails.
 */
describe("the relay link: what it logs", () => {
  const usage = (agentId: string, requests: number) => ({
    type: "relay_usage",
    agents: [{ agentId, requests, refused: 0, bytesIn: 1, bytesOut: 2 }],
  });

  it("logs each relay_usage, and no mismatch while the requests match the turns the workers reported (I4)", async () => {
    // A long run: 40 turns in the window, 40 provider requests. The old runs-based check would have warned.
    const { link, last, lines } = bed({ turns: () => 40 });
    await link.start();
    last().ready();
    last().emit("message", usage("scout-0001", 40));
    expect(lines.filter((line) => line.msg === "agent_relay_usage")).toHaveLength(1);
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toEqual([]);
  });

  it("logs a mismatch once when requests exceed the reported turns by more than 10 (M-mismatch)", async () => {
    const turns = new Map([["scout-0001", 5]]);
    const { link, last, lines } = bed({ turns: (agentId) => turns.get(agentId) ?? 0 });
    await link.start();
    last().ready();
    last().emit("message", usage("scout-0001", 15));
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toEqual([]);
    last().emit("message", usage("scout-0001", 16));
    const mismatches = lines.filter((line) => line.msg === "agent_relay_mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ agentId: "scout-0001", requests: 16, turns: 5 });
  });

  it("requests with no turns at all are a mismatch", async () => {
    const { link, last, lines } = bed({ turns: () => 0 });
    await link.start();
    last().ready();
    last().emit("message", usage("scout-0001", 11));
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toHaveLength(1);
  });

  it("tells the composition each window ended, so the counts start again (M-window)", async () => {
    const windowEnded = vi.fn();
    const { link, last } = bed({ windowEnded });
    await link.start();
    last().ready();
    last().emit("message", usage("scout-0001", 1));
    last().emit("message", { type: "relay_usage", agents: "malformed" });
    expect(windowEnded).toHaveBeenCalledTimes(1);
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
