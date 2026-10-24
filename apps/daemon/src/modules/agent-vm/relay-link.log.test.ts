import { describe, expect, it, vi } from "vitest";
import { bed, grant, KEY, TOKEN } from "./testing/relay-link-bed.ts";

/*
 * Mutants (RT-43), run for real: M-mismatch (the 10-request margin dropped, or judged on the first agent only), M-window (`windowEnded`
 * not told), M-log-secret (a log line carries the relay key or the Claude token).
 */

/*
 * Mutants (RT-43), each run for real:
 *  - M-mismatch: the threshold is dropped -> "logs a mismatch once when" fails; the turns not read -> "no mismatch while" fails.
 *  - M-window: the window's end is not told -> "tells the composition each window ended" fails.
 *  - M-log-secret: a log line carries the relay key or the Claude token -> "no secret in a log line" fails.
 */
describe("the relay link: what it logs", () => {
  const usage = (agentId: string, requests: number) => ({
    type: "relay_usage",
    boxes: [{ box: { kind: "agent", id: agentId }, requests, refused: 0, bytesIn: 1, bytesOut: 2 }],
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

  // AVM-E41 m4 (the assertions the split dropped). Mutant: the log line leaves out `refused` -> the first expect fails;
  // the mismatch is judged on the report's first agent only -> the mismatch expect fails.
  it("logs the fields of every agent of one report, and a mismatch for the one that is over the margin only (M-mismatch)", async () => {
    const turns = new Map([
      ["scout-0001", 5],
      ["busy-0002", 5],
    ]);
    const { link, last, lines } = bed({ turns: (box) => turns.get(box.id) ?? 0 });
    await link.start();
    last().ready();
    last().emit("message", {
      type: "relay_usage",
      boxes: [
        { box: { kind: "agent", id: "scout-0001" }, requests: 15, refused: 1, bytesIn: 10, bytesOut: 20 },
        { box: { kind: "agent", id: "busy-0002" }, requests: 16, refused: 0, bytesIn: 1, bytesOut: 2 },
      ],
    });
    const logged = lines.filter((line) => line.msg === "agent_relay_usage");
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      box: "agent:scout-0001",
      requests: 15,
      refused: 1,
      bytesIn: 10,
      bytesOut: 20,
    });
    expect(logged[1]).toMatchObject({
      box: "agent:busy-0002",
      requests: 16,
      refused: 0,
      bytesIn: 1,
      bytesOut: 2,
    });
    const mismatches = lines.filter((line) => line.msg === "agent_relay_mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ box: "agent:busy-0002", requests: 16, turns: 5 });
  });

  it("logs a project box's usage and never a mismatch for it (it reports no turns)", async () => {
    const { link, last, lines } = bed({ turns: () => 0 });
    await link.start();
    last().ready();
    last().emit("message", {
      type: "relay_usage",
      boxes: [
        {
          box: { kind: "project", id: "6f1c2f0e-8f5b-4b53-9a52-0d2f4a4c7d11" },
          requests: 40,
          refused: 0,
          bytesIn: 1,
          bytesOut: 2,
        },
      ],
    });
    expect(lines.filter((line) => line.msg === "agent_relay_usage")).toHaveLength(1);
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toEqual([]);
  });

  it("logs a mismatch once when requests exceed the reported turns by more than 10 (M-mismatch)", async () => {
    const turns = new Map([["scout-0001", 5]]);
    const { link, last, lines } = bed({ turns: (box) => turns.get(box.id) ?? 0 });
    await link.start();
    last().ready();
    last().emit("message", usage("scout-0001", 15));
    expect(lines.filter((line) => line.msg === "agent_relay_mismatch")).toEqual([]);
    last().emit("message", usage("scout-0001", 16));
    const mismatches = lines.filter((line) => line.msg === "agent_relay_mismatch");
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toMatchObject({ box: "agent:scout-0001", requests: 16, turns: 5 });
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
    last().emit("message", { type: "relay_usage", boxes: "malformed" });
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
    last().emit("message", { type: "relay_usage", boxes: "no", key: KEY });
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
