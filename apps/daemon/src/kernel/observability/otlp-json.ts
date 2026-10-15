import type { MetricSnapshot } from "./prometheus.ts";
import type { ExportedSpan } from "./tracer.ts";

/** The only resource attributes that leave (M10R99). */
export interface OtlpResource {
  readonly serviceName: string;
  readonly serviceVersion: string;
}

type AnyValue =
  { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
interface KeyValue {
  readonly key: string;
  readonly value: AnyValue;
}

const SPAN_KIND_INTERNAL = 1;
const STATUS_OK = 1;
const STATUS_ERROR = 2;
const CUMULATIVE = 2;
const SCOPE = { name: "pap" };

const nanos = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString();

function anyValue(value: number | boolean | string): AnyValue {
  if (typeof value === "boolean") return { boolValue: value };
  if (typeof value === "string") return { stringValue: value };
  return Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value };
}

const resourceOf = (resource: OtlpResource) => ({
  attributes: [
    { key: "service.name", value: { stringValue: resource.serviceName } },
    { key: "service.version", value: { stringValue: resource.serviceVersion } },
  ],
});

/**
 * OTLP/HTTP JSON for `POST /v1/traces`. A span has no parent and no identity of its own, so each gets fresh random ids.
 * The attributes are the tracer's closed ones, as they are; the outcome becomes the status (a failure is code 2 with the
 * closed outcome token as its message).
 */
export function tracesBody(
  spans: readonly ExportedSpan[],
  resource: OtlpResource,
  randomHex: (bytes: number) => string,
): object {
  return {
    resourceSpans: [
      {
        resource: resourceOf(resource),
        scopeSpans: [
          {
            scope: SCOPE,
            spans: spans.map((span) => ({
              traceId: randomHex(16),
              spanId: randomHex(8),
              name: span.name,
              kind: SPAN_KIND_INTERNAL,
              startTimeUnixNano: nanos(span.start),
              endTimeUnixNano: nanos(span.start + span.durationMs),
              attributes: Object.entries(span.attrs).flatMap(([key, value]): KeyValue[] =>
                value === undefined ? [] : [{ key, value: anyValue(value) }],
              ),
              status:
                span.outcome === "ok" ? { code: STATUS_OK } : { code: STATUS_ERROR, message: span.outcome },
            })),
          },
        ],
      },
    ],
  };
}

/** OTLP/HTTP JSON for `POST /v1/metrics`: counters as cumulative monotonic sums since `startedAt`, gauges as they are. */
export function metricsBody(
  snapshot: MetricSnapshot,
  resource: OtlpResource,
  at: number,
  startedAt: number,
): object {
  const metrics = snapshot
    .filter((family) => family.samples.length > 0)
    .map((family) => {
      const dataPoints = family.samples.map((sample) => ({
        attributes: Object.entries(sample.labels).map(([key, value]) => ({
          key,
          value: { stringValue: value },
        })),
        ...(family.type === "counter" ? { startTimeUnixNano: nanos(startedAt) } : {}),
        timeUnixNano: nanos(at),
        asDouble: sample.value,
      }));
      return family.type === "counter"
        ? {
            name: family.name,
            description: family.help,
            sum: { aggregationTemporality: CUMULATIVE, isMonotonic: true, dataPoints },
          }
        : { name: family.name, description: family.help, gauge: { dataPoints } };
    });
  return {
    resourceMetrics: [{ resource: resourceOf(resource), scopeMetrics: [{ scope: SCOPE, metrics }] }],
  };
}
