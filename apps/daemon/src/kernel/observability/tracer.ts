import { ERROR_CODES, methods, PapError } from "@pap/contracts";
import type { Clock } from "../clock.ts";
import { DEADLINE_MS } from "../outbox/store.ts";

/** A line over this size is dropped and counted: a span is five short fields, never content (M10R91). */
export const MAX_SPAN_BYTES = 1024;

export type SpanName =
  | `rpc.${string}`
  | `outbox.${string}`
  | "hook"
  | "fire"
  | "precheck"
  | "feed.fetch"
  | "task.start"
  | "run"
  | "scheduler.tick"
  | "event_loop.stall";

export type AttrKey = "verdict" | "status" | "origin" | "code" | "bytes" | "count";
export type SpanAttrs = Partial<Record<AttrKey, number | boolean | string>>;

/** The attribute keys each name takes. A key outside its set is dropped; no name takes an id, a param, a path or a text. */
const OTHER_ATTRS: Readonly<Record<string, readonly AttrKey[]>> = {
  hook: ["verdict", "status", "origin", "bytes"],
  fire: ["verdict", "origin", "count"],
  precheck: ["verdict", "code", "bytes"],
  "feed.fetch": ["status", "bytes", "count"],
  "task.start": ["origin", "code"],
  run: ["origin", "status", "code"],
  "scheduler.tick": ["count"],
  "event_loop.stall": [],
};
const OUTBOX_ATTRS: readonly AttrKey[] = ["code", "count"];
const RPC_ATTRS: readonly AttrKey[] = ["code"];
/** A string value is a short token (`accepted`, `manual`), never free text. */
const CLOSED_STRING = /^[a-z0-9_.-]{1,32}$/;

const OUTCOMES: ReadonlySet<string> = new Set(["ok", "error", ...ERROR_CODES]);

/** `ok`, an error code of `ERROR_CODES`, or `error`: a thrown `PapError` gives its code, anything else `error`. */
export function outcomeOf(outcome: unknown): string {
  if (outcome === undefined) return "ok";
  if (outcome instanceof PapError) return outcome.code;
  return typeof outcome === "string" && OUTCOMES.has(outcome) ? outcome : "error";
}

function nameFor(name: string): { name: string; keys: readonly AttrKey[] } | null {
  if (name.startsWith("rpc.")) {
    const method = name.slice(4);
    return { name: Object.hasOwn(methods, method) ? name : "rpc.unknown", keys: RPC_ATTRS };
  }
  if (name.startsWith("outbox.")) {
    return Object.hasOwn(DEADLINE_MS, name.slice(7)) ? { name, keys: OUTBOX_ATTRS } : null;
  }
  const keys = Object.hasOwn(OTHER_ATTRS, name) ? OTHER_ATTRS[name] : undefined;
  return keys ? { name, keys } : null;
}

export interface Span {
  /** Writes the line, once; a second call does nothing. `outcome` is `"ok"` when absent. */
  end(outcome?: unknown, attrs?: SpanAttrs): void;
}

export interface Tracer {
  span(name: SpanName, attrs?: SpanAttrs): Span;
  /** A span measured elsewhere. */
  record(
    name: SpanName,
    span: { start: number; durationMs: number; outcome?: unknown; attrs?: SpanAttrs },
  ): void;
  /** `createDispatcher`'s `onCall`: one `rpc.<method>` span per call. */
  onCall(method: string, durationMs: number, outcome: string): void;
  /** Lines refused so far: an unknown name, an attribute value that is not closed, over 1 KiB, or a failed write. */
  dropped(): number;
}

export interface TraceSink {
  append(line: string): void;
}

/** What the OTLP exporter is given: the same closed span the file line holds, nothing more (M10R99). */
export interface ExportedSpan {
  readonly name: string;
  readonly start: number;
  readonly durationMs: number;
  readonly outcome: string;
  readonly attrs: SpanAttrs;
}

/**
 * One NDJSON line per ended span: `{name, start, durationMs, outcome, attrs}` (M10R91). It never throws: a line it
 * cannot write is counted. A `null` file (read-only mode) keeps the shape and writes nothing.
 */
export function createTracer(options: {
  readonly clock: Pick<Clock, "now">;
  readonly file: TraceSink | null;
  /** Each span that passed the closed checks, written to the file or not; a throw is counted, never raised. */
  readonly onSpan?: (span: ExportedSpan) => void;
}): Tracer {
  const { clock, file, onSpan } = options;
  let refused = 0;

  function closedAttrs(keys: readonly AttrKey[], attrs: SpanAttrs | undefined): SpanAttrs | null {
    const kept: Record<string, number | boolean | string> = {};
    for (const key of keys) {
      const value = attrs?.[key];
      if (value === undefined) continue;
      const closed =
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && CLOSED_STRING.test(value));
      if (!closed) return null;
      kept[key] = value;
    }
    return kept;
  }

  function write(
    name: string,
    span: { start: number; durationMs: number; outcome?: unknown; attrs?: SpanAttrs },
  ): void {
    const known = nameFor(name);
    const attrs = known ? closedAttrs(known.keys, span.attrs) : null;
    if (!known || !attrs) {
      refused++;
      return;
    }
    if (file === null && !onSpan) return;
    const closed: ExportedSpan = {
      name: known.name,
      start: span.start,
      durationMs: Math.max(0, Math.round(span.durationMs)),
      outcome: outcomeOf(span.outcome),
      attrs,
    };
    const line = JSON.stringify(closed);
    if (Buffer.byteLength(line) > MAX_SPAN_BYTES) {
      refused++;
      return;
    }
    if (onSpan) {
      try {
        onSpan(closed);
      } catch {
        refused++;
      }
    }
    if (file === null) return;
    try {
      file.append(line);
    } catch {
      refused++;
    }
  }

  return {
    span(name, attrs) {
      const start = clock.now();
      let ended = false;
      return {
        end(outcome, more) {
          if (ended) return;
          ended = true;
          write(name, { start, durationMs: clock.now() - start, outcome, attrs: { ...attrs, ...more } });
        },
      };
    },
    record: write,
    onCall(method, durationMs, outcome) {
      write(`rpc.${method}`, { start: clock.now() - durationMs, durationMs, outcome });
    },
    dropped: () => refused,
  };
}
