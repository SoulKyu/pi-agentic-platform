import { describe, expect, it } from "vitest";
import { metricsBody, tracesBody } from "./otlp-json.ts";

const resource = { serviceName: "pap-home", serviceVersion: "1.2.3" };
const RESOURCE_JSON = {
  attributes: [
    { key: "service.name", value: { stringValue: "pap-home" } },
    { key: "service.version", value: { stringValue: "1.2.3" } },
  ],
};

function counterOf(start: number) {
  let next = start;
  return (bytes: number): string => (next++).toString(16).padStart(bytes * 2, "0");
}

describe("tracesBody", () => {
  it("is the exact OTLP JSON of an ok span and a failed one", () => {
    const body = tracesBody(
      [
        {
          name: "rpc.sessions.list",
          start: 1_700_000_000_123,
          durationMs: 45,
          outcome: "ok",
          attrs: {},
        },
        {
          name: "hook",
          start: 1_700_000_001_000,
          durationMs: 3,
          outcome: "forbidden",
          attrs: { verdict: "rejected", status: 403, bytes: 12.5, count: 0 },
        },
      ],
      resource,
      counterOf(1),
    );
    expect(body).toEqual({
      resourceSpans: [
        {
          resource: RESOURCE_JSON,
          scopeSpans: [
            {
              scope: { name: "pap" },
              spans: [
                {
                  traceId: "00000000000000000000000000000001",
                  spanId: "0000000000000002",
                  name: "rpc.sessions.list",
                  kind: 1,
                  startTimeUnixNano: "1700000000123000000",
                  endTimeUnixNano: "1700000000168000000",
                  attributes: [],
                  status: { code: 1 },
                },
                {
                  traceId: "00000000000000000000000000000003",
                  spanId: "0000000000000004",
                  name: "hook",
                  kind: 1,
                  startTimeUnixNano: "1700000001000000000",
                  endTimeUnixNano: "1700000001003000000",
                  attributes: [
                    { key: "verdict", value: { stringValue: "rejected" } },
                    { key: "status", value: { intValue: "403" } },
                    { key: "bytes", value: { doubleValue: 12.5 } },
                    { key: "count", value: { intValue: "0" } },
                  ],
                  status: { code: 2, message: "forbidden" },
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("writes a boolean attribute as boolValue and the resource with the two keys only", () => {
    const body = tracesBody(
      [{ name: "run", start: 1, durationMs: 0, outcome: "error", attrs: { status: true } }],
      resource,
      counterOf(1),
    ) as {
      resourceSpans: Array<{
        resource: unknown;
        scopeSpans: Array<{ spans: Array<{ attributes: unknown }> }>;
      }>;
    };
    expect(body.resourceSpans[0]?.resource).toEqual(RESOURCE_JSON);
    expect(body.resourceSpans[0]?.scopeSpans[0]?.spans[0]?.attributes).toEqual([
      { key: "status", value: { boolValue: true } },
    ]);
  });
});

describe("metricsBody", () => {
  it("is the exact OTLP JSON of a cumulative counter and a gauge, skipping a family without samples", () => {
    const body = metricsBody(
      [
        {
          name: "pap_runs_total",
          type: "counter",
          help: "Runs.",
          samples: [{ labels: { origin: "manual" }, value: 7 }],
        },
        {
          name: "pap_workers_active",
          type: "gauge",
          help: "Workers.",
          samples: [{ labels: {}, value: 2.5 }],
        },
        { name: "pap_empty", type: "gauge", help: "None.", samples: [] },
      ],
      resource,
      1_700_000_060_000,
      1_700_000_000_000,
    );
    expect(body).toEqual({
      resourceMetrics: [
        {
          resource: RESOURCE_JSON,
          scopeMetrics: [
            {
              scope: { name: "pap" },
              metrics: [
                {
                  name: "pap_runs_total",
                  description: "Runs.",
                  sum: {
                    aggregationTemporality: 2,
                    isMonotonic: true,
                    dataPoints: [
                      {
                        attributes: [{ key: "origin", value: { stringValue: "manual" } }],
                        startTimeUnixNano: "1700000000000000000",
                        timeUnixNano: "1700000060000000000",
                        asDouble: 7,
                      },
                    ],
                  },
                },
                {
                  name: "pap_workers_active",
                  description: "Workers.",
                  gauge: {
                    dataPoints: [{ attributes: [], timeUnixNano: "1700000060000000000", asDouble: 2.5 }],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
  });
});
