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
// Matched on whole words of the key (camelCase and separators split into words), so `accessToken`,
// `x-api-key` and `passwd` are secrets while `inputTokens`, `bypass` and `passed` are not.
const SECRET_WORDS =
  /(?:^|_)(?:pass|passwd|passwords?|passphrase|secrets?|token|cookies?|authorization|credentials?|api_?key|private_?key|signing_?key|encryption_?key|hmac|bearer|jwt)(?:_|$)/;
const MAX_STRING = 2000;
const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const REDACTED = "[REDACTED]";
const UNREADABLE = "[Unreadable]";
const FALLBACK_LINE = '{"level":"error","msg":"log_serialization_failed"}\n';

const keyWords = (key: string): string =>
  key
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z\d]+/g, "_")
    .toLowerCase();

// A bare `tokens` is a secret list unless it holds a count.
function isSecretKey(key: string, value: unknown): boolean {
  const words = keyWords(key);
  return SECRET_WORDS.test(words) || (words === "tokens" && typeof value !== "number");
}

function read(get: () => unknown): unknown {
  try {
    return get();
  } catch {
    return UNREADABLE;
  }
}

const clip = (text: string): string => (text.length > MAX_STRING ? `${text.slice(0, MAX_STRING)}…` : text);

// Total: never throws, whatever it is given. Objects past the depth or key cap are cut, never passed
// through (they may hold secrets); a cycle is any object that is its own ancestor.
export function redact(value: unknown): unknown {
  return walk(value, 0, new WeakSet());
}

function walk(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  if (typeof value === "string") return clip(value);
  if (typeof value === "bigint") return value.toString();
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "[Invalid Date]" : value.toISOString();
  if (value instanceof Error) {
    return { name: clip(String(read(() => value.name))), message: clip(String(read(() => value.message))) };
  }
  if (ancestors.has(value)) return "[Circular]";
  if (depth >= MAX_DEPTH) return "[Truncated]";
  ancestors.add(value);
  try {
    return Array.isArray(value) ? walkArray(value, depth, ancestors) : walkObject(value, depth, ancestors);
  } catch {
    return UNREADABLE;
  } finally {
    ancestors.delete(value);
  }
}

function walkArray(items: unknown[], depth: number, ancestors: WeakSet<object>): unknown[] {
  const out: unknown[] = [];
  for (let index = 0; index < Math.min(items.length, MAX_KEYS); index++) {
    out.push(
      walk(
        read(() => items[index]),
        depth + 1,
        ancestors,
      ),
    );
  }
  if (items.length > MAX_KEYS) out.push("[Truncated]");
  return out;
}

function walkObject(object: object, depth: number, ancestors: WeakSet<object>): LogFields {
  const keys = Object.keys(object);
  const entries = keys.slice(0, MAX_KEYS).map((key): [string, unknown] => {
    const item = read(() => (object as LogFields)[key]);
    return [key, isSecretKey(key, item) ? REDACTED : walk(item, depth + 1, ancestors)];
  });
  if (keys.length > MAX_KEYS) entries.push(["[Truncated]", keys.length - MAX_KEYS]);
  return Object.fromEntries(entries);
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
    let line: string;
    try {
      const body = {
        ...(redact(options.bindings) as LogFields | undefined),
        ...(redact(fields) as LogFields | undefined),
      };
      const head = { time: new Date(options.clock.now()).toISOString(), level, msg };
      // head leads and wins: a caller field named time, level or msg cannot rewrite the entry.
      line = `${JSON.stringify({ ...head, ...body, ...head })}\n`;
    } catch {
      line = FALLBACK_LINE;
    }
    try {
      options.write(line);
    } catch {
      // A failing sink must never take the caller down, and there is nowhere left to report it.
    }
  };
  return {
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    child: (bindings) =>
      createLogger({
        ...options,
        bindings: { ...options.bindings, ...(redact(bindings) as LogFields) },
      }),
  };
}

export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
