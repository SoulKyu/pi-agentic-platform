import type { Clock } from "../clock.ts";
import type { Logger } from "../logger.ts";
import { createRateLimiter } from "../rate-limit.ts";

export type Labels = Readonly<Record<string, string>>;

export interface Sample {
  readonly labels?: Labels;
  readonly value: number;
}

export type MetricType = "counter" | "gauge";

export interface MetricFamily {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly samples: readonly { readonly labels: Labels; readonly value: number }[];
}

export type MetricSnapshot = readonly MetricFamily[];

type Reader = () => readonly Sample[] | Promise<readonly Sample[]>;

export interface MetricsRegistry {
  /** A family read at each scrape. A reader that throws, or reports a label it did not declare, drops its family. */
  counter(name: string, help: string, labelNames: readonly string[], read: Reader): void;
  gauge(name: string, help: string, labelNames: readonly string[], read: Reader): void;
  /** Prometheus text format 0.0.4, built from validated values only. */
  collect(): Promise<string>;
  /** The families of the last `collect`. */
  snapshot(): MetricSnapshot;
}

const NAME = /^[a-zA-Z_:][a-zA-Z0-9_:]*$/;
const LABEL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const LOG_EVERY_MS = 60_000;

const escapeLabel = (value: string): string =>
  value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const escapeHelp = (value: string): string => value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n");

interface Registered {
  readonly name: string;
  readonly type: MetricType;
  readonly help: string;
  readonly labelNames: readonly string[];
  readonly read: Reader;
}

export function createMetricsRegistry(deps: {
  readonly clock: Clock;
  readonly logger: Logger;
}): MetricsRegistry {
  const families: Registered[] = [];
  const limiter = createRateLimiter(deps.clock, LOG_EVERY_MS);
  let last: MetricFamily[] = [];

  function add(
    type: MetricType,
    name: string,
    help: string,
    labelNames: readonly string[],
    read: Reader,
  ): void {
    if (!NAME.test(name) || labelNames.some((label) => !LABEL_NAME.test(label)))
      throw new Error("not a Prometheus identifier");
    if (families.some((family) => family.name === name)) throw new Error("metric registered twice");
    families.push({ name, type, help, labelNames, read });
  }

  async function read(family: Registered): Promise<MetricFamily | null> {
    try {
      const samples = (await family.read()).map((sample) => {
        const labels = sample.labels ?? {};
        if (!Number.isFinite(sample.value)) throw new Error("value is not a number");
        if (Object.keys(labels).some((key) => !family.labelNames.includes(key)))
          throw new Error("undeclared label");
        return { labels, value: sample.value };
      });
      return { name: family.name, type: family.type, help: family.help, samples };
    } catch {
      // The reason may hold a value from a row: only the family's name is logged.
      const verdict = limiter.check(family.name);
      if (verdict.allowed)
        deps.logger.warn("metrics_collector_failed", { name: family.name, suppressed: verdict.suppressed });
      return null;
    }
  }

  return {
    counter: (name, help, labelNames, reader) => add("counter", name, help, labelNames, reader),
    gauge: (name, help, labelNames, reader) => add("gauge", name, help, labelNames, reader),
    async collect() {
      const read_ = await Promise.all(families.map(read));
      last = read_.filter((family): family is MetricFamily => family !== null);
      const lines: string[] = [];
      for (const family of last) {
        const names = families.find((registered) => registered.name === family.name)?.labelNames ?? [];
        lines.push(
          `# HELP ${family.name} ${escapeHelp(family.help)}`,
          `# TYPE ${family.name} ${family.type}`,
        );
        for (const { labels, value } of family.samples) {
          const body = names
            .filter((key) => labels[key] !== undefined)
            .map((key) => `${key}="${escapeLabel(labels[key] ?? "")}"`)
            .join(",");
          lines.push(`${family.name}${body ? `{${body}}` : ""} ${value}`);
        }
      }
      return `${lines.join("\n")}\n`;
    },
    snapshot: () => last,
  };
}
