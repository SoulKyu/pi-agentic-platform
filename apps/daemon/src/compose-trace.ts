import type { M10Core } from "./compose-automation.ts";
import { createExporter, type Exporter } from "./kernel/observability/otlp.ts";
import { createStallMonitor, type StallMonitor } from "./kernel/observability/stall.ts";
import { createTraceFile } from "./kernel/observability/trace-file.ts";
import { createTracer, type Tracer } from "./kernel/observability/tracer.ts";

export interface ComposedTrace {
  readonly tracer: Tracer;
  readonly stall: StallMonitor;
  /** The opt-in OTLP exporter; null unless `PAP_OTLP_ENDPOINT` is set, and always null in read-only mode (M10R98). */
  readonly exporter: Exporter | null;
  /** Spans lost: refused by the tracer's checks or the local file, or by the OTLP export (M10R99). */
  dropped(): number;
  /** What the dispatcher is given: one `rpc.<method>` span per call (M10R92). */
  readonly onCall: Tracer["onCall"];
  /** Flushes nothing (writes are synchronous) and releases the file and the sampler. */
  close(): void;
}

/**
 * The trace file and the stall monitor (M10R91, M10R93). Read-only mode: no file is opened, so nothing is written; the
 * counters still run. The monitor is armed by `start()` of the caller, after `startServer`.
 */
export function composeTrace(core: M10Core): ComposedTrace {
  const file = core.readOnly ? null : createTraceFile(core.config.home);
  const exporter = core.readOnly
    ? null
    : createExporter({ config: core.config.otlp, clock: core.clock, logger: core.logger });
  const tracer = createTracer({
    clock: core.clock,
    file,
    ...(exporter && { onSpan: (span) => exporter.enqueue(span) }),
  });
  const stall = createStallMonitor({ clock: core.clock, logger: core.logger, tracer });
  return {
    tracer,
    stall,
    exporter,
    dropped: () => tracer.dropped() + (exporter?.dropped() ?? 0),
    onCall: (method, durationMs, outcome) => tracer.onCall(method, durationMs, outcome),
    close() {
      stall.stop();
      file?.close();
    },
  };
}
