import { describe, expect, it } from "vitest";
import { createFakeClock } from "../clock.ts";
import { createLogger } from "../logger.ts";
import { createMetricsRegistry } from "./prometheus.ts";

function open() {
  const logs: Array<Record<string, unknown>> = [];
  const clock = createFakeClock();
  const logger = createLogger({
    level: "warn",
    clock,
    write: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { registry: createMetricsRegistry({ clock, logger }), logs };
}

describe("the Prometheus text", () => {
  it("renders a counter and a gauge with HELP, TYPE, label order, a zero and no trailing space", async () => {
    const { registry } = open();
    registry.counter("pap_runs_total", "Runs by origin and status.", ["origin", "status"], () => [
      { labels: { status: "completed", origin: "user" }, value: 3 },
      { labels: { origin: "feed", status: "failed" }, value: 0 },
    ]);
    registry.gauge("pap_workers_max", "Workers at most.", [], () => [{ value: 4 }]);
    expect(await registry.collect()).toBe(
      [
        "# HELP pap_runs_total Runs by origin and status.",
        "# TYPE pap_runs_total counter",
        'pap_runs_total{origin="user",status="completed"} 3',
        'pap_runs_total{origin="feed",status="failed"} 0',
        "# HELP pap_workers_max Workers at most.",
        "# TYPE pap_workers_max gauge",
        "pap_workers_max 4",
        "",
      ].join("\n"),
    );
  });

  it("renders fractions and escapes what a label value could break the line with", async () => {
    const { registry } = open();
    registry.gauge("pap_x", "x", ["a"], () => [{ labels: { a: 'q"\\\n}' }, value: 0.25 }]);
    expect(await registry.collect()).toContain('pap_x{a="q\\"\\\\\\n}"} 0.25\n');
  });

  it("drops a family whose collector throws, logs it, and renders the rest", async () => {
    const { registry, logs } = open();
    registry.gauge("pap_bad", "bad", [], () => {
      throw new Error("boom");
    });
    registry.gauge("pap_good", "good", [], () => [{ value: 1 }]);
    const text = await registry.collect();
    expect(text).not.toContain("pap_bad");
    expect(text).toContain("pap_good 1\n");
    expect(logs).toEqual([expect.objectContaining({ msg: "metrics_collector_failed", name: "pap_bad" })]);
  });

  it("drops a family that reports a label it did not declare or a value that is not a number", async () => {
    const { registry } = open();
    registry.gauge("pap_a", "a", ["k"], () => [{ labels: { other: "v" }, value: 1 }]);
    registry.gauge("pap_b", "b", [], () => [{ value: Number.NaN }]);
    registry.gauge("pap_c", "c", [], async () => [{ value: 2 }]);
    expect(await registry.collect()).toBe("# HELP pap_c c\n# TYPE pap_c gauge\npap_c 2\n");
  });

  it("refuses a name or a label name that is not a Prometheus identifier", () => {
    const { registry } = open();
    expect(() => registry.gauge("bad name", "x", [], () => [])).toThrow();
    expect(() => registry.gauge("pap_ok", "x", ["bad-label"], () => [])).toThrow();
  });

  it("keeps the last collected samples as a snapshot", async () => {
    const { registry } = open();
    registry.gauge("pap_g", "g", [], () => [{ value: 7 }]);
    await registry.collect();
    expect(registry.snapshot()).toEqual([
      { name: "pap_g", type: "gauge", help: "g", samples: [{ labels: {}, value: 7 }] },
    ]);
  });
});
