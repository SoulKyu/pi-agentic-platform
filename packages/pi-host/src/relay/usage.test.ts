import { RELAY_USAGE_MAX_AGENTS, RelayReport } from "@pap/contracts";
import { describe, expect, it } from "vitest";
import { fakeClock } from "../testing/guest-harness.ts";
import { createUsage } from "./usage.ts";

/*
 * Mutants (RT-43), each run for real:
 *  - M-reset: keep the counts after a report -> "resets after each report" fails.
 *  - M-split: one report whatever the number of agents -> "splits a long report" fails.
 */
const setup = () => {
  const clock = fakeClock();
  const reports: unknown[] = [];
  const usage = createUsage(clock, (report) => reports.push(report));
  return { clock, reports, usage };
};

describe("createUsage", () => {
  it("counts per agent and reports every 60 seconds", () => {
    const { clock, reports, usage } = setup();
    usage.start();
    usage.request("scout-0001", { bytesIn: 10 });
    usage.finished("scout-0001", { bytesOut: 100 });
    usage.request("scout-0001", { bytesIn: 5 });
    usage.refused("scout-0001");
    usage.request("scout-0002", { bytesIn: 1 });
    clock.advance(59_999);
    expect(reports).toEqual([]);
    clock.advance(1);
    expect(reports).toEqual([
      {
        type: "relay_usage",
        agents: [
          { agentId: "scout-0001", requests: 2, refused: 1, bytesIn: 15, bytesOut: 100 },
          { agentId: "scout-0002", requests: 1, refused: 0, bytesIn: 1, bytesOut: 0 },
        ],
      },
    ]);
    expect(RelayReport.safeParse(reports[0]).success).toBe(true);
  });

  it("resets after each report and sends nothing when nothing happened (M-reset)", () => {
    const { clock, reports, usage } = setup();
    usage.start();
    usage.request("scout-0001", { bytesIn: 1 });
    clock.advance(60_000);
    clock.advance(60_000);
    expect(reports).toHaveLength(1);
    usage.request("scout-0001", { bytesIn: 2 });
    clock.advance(60_000);
    expect(reports[1]).toEqual({
      type: "relay_usage",
      agents: [{ agentId: "scout-0001", requests: 1, refused: 0, bytesIn: 2, bytesOut: 0 }],
    });
  });

  it("counts a refusal that never became a request", () => {
    const { clock, reports, usage } = setup();
    usage.start();
    usage.refused("scout-0001");
    clock.advance(60_000);
    expect(reports[0]).toEqual({
      type: "relay_usage",
      agents: [{ agentId: "scout-0001", requests: 0, refused: 1, bytesIn: 0, bytesOut: 0 }],
    });
  });

  it("splits a long report (M-split)", () => {
    const { clock, reports, usage } = setup();
    usage.start();
    const total = RELAY_USAGE_MAX_AGENTS * 2 + 1;
    for (let i = 0; i < total; i++) usage.request(`a-${i.toString(16).padStart(4, "0")}`, { bytesIn: 1 });
    clock.advance(60_000);
    expect(reports).toHaveLength(3);
    const sizes = (reports as Array<{ agents: unknown[] }>).map((report) => report.agents.length);
    expect(sizes).toEqual([RELAY_USAGE_MAX_AGENTS, RELAY_USAGE_MAX_AGENTS, 1]);
    for (const report of reports) expect(RelayReport.safeParse(report).success).toBe(true);
  });

  it("stop ends the timer", () => {
    const { clock, usage } = setup();
    usage.start();
    usage.stop();
    expect(clock.pending()).toBe(0);
  });

  it("start twice keeps one timer", () => {
    const { clock, usage } = setup();
    usage.start();
    usage.start();
    expect(clock.pending()).toBe(1);
  });
});
