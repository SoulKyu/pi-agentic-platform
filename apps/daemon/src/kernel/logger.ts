import type { Clock } from "./clock.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /pass(word)?|secret|token|cookie|authorization|api[-_]?key|credential/i;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (typeof value === "string") return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  if (value === null || typeof value !== "object") return value;
  // Past the cap an object is cut, never passed through: it may hold secrets or loop back on itself.
  if (depth >= MAX_DEPTH) return "[Truncated]";
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SECRET_KEY.test(key) ? "[REDACTED]" : redact(item, depth + 1),
    ]),
  );
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly clock: Clock;
  readonly write: (line: string) => void;
  readonly bindings?: LogFields;
}

export function createLogger(options: LoggerOptions): Logger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields) => {
    if (RANK[level] < RANK[options.level]) return;
    const body = redact({ ...options.bindings, ...fields }) as LogFields;
    const head = { time: new Date(options.clock.now()).toISOString(), level, msg };
    // head leads and wins: a caller field named time, level or msg cannot rewrite the entry.
    options.write(`${JSON.stringify({ ...head, ...body, ...head })}\n`);
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bindings) => createLogger({ ...options, bindings: { ...options.bindings, ...bindings } }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
