import { createHash } from "node:crypto";

/** Deeper than any real tool input; a cycle hits it too. */
const MAX_DEPTH = 32;
/**
 * Work budget in characters: strings, keys and numbers are charged their length, other values and each separator a
 * few. The pipeline states every input (audit arguments, grant key) before `describeCall` looks at it, so this budget
 * is the first bound on a non-shell input; `describeCall` caps what a person is asked to read later.
 */
const MAX_CANONICAL_CHARS = 2 * 1024 * 1024;

/**
 * Canonical JSON of tool input, which is untrusted: keys sorted, `undefined` properties left out. It throws on what it
 * cannot state exactly (too deep, too large, a function, a bigint, NaN, a class instance), so the caller fails closed
 * instead of giving two different calls one key. Inputs equal as JSON share a key on purpose: `-0` and `0`, and
 * `[undefined]` and `[null]` (JSON states both the same way).
 */
function canonical(root: unknown): string {
  let budget = MAX_CANONICAL_CHARS;
  const spend = (amount: number): void => {
    budget -= amount;
    if (budget < 0) throw new RangeError("the tool input is too large for a grant key");
  };
  const walk = (value: unknown, depth: number): string => {
    if (depth > MAX_DEPTH) throw new RangeError("the tool input is too deep for a grant key");
    if (value === null || typeof value === "boolean") {
      spend(5);
      return `${value}`;
    }
    if (typeof value === "string") {
      spend(value.length + 2);
      return JSON.stringify(value);
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new TypeError("the tool input holds a number JSON cannot state");
      const text = JSON.stringify(value);
      spend(text.length);
      return text;
    }
    if (Array.isArray(value)) {
      spend(2 + value.length);
      return `[${value.map((item) => (item === undefined ? "null" : walk(item, depth + 1))).join(",")}]`;
    }
    if (typeof value === "object") {
      const prototype = Object.getPrototypeOf(value) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("the tool input holds an object that is not plain data");
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).filter((key) => record[key] !== undefined);
      spend(2 + keys.length * 2);
      return `{${keys
        .sort()
        .map((key) => {
          spend(key.length + 2);
          return `${JSON.stringify(key)}:${walk(record[key], depth + 1)}`;
        })
        .join(",")}}`;
    }
    throw new TypeError("the tool input holds a value JSON cannot state");
  };
  return walk(root, 0);
}

/** What a grant covers: the exact command of a built-in shell call (`cmd`), else the exact input, keys sorted (`json`). */
export interface GrantPayload {
  readonly kind: "cmd" | "json";
  readonly payload: string;
}

/** Throws when the input cannot be stated exactly and within bounds: the policy treats that as an evaluation error. */
export function grantPayload(input: unknown, exec: boolean): GrantPayload {
  const command = (input as { command?: unknown } | null)?.command;
  return exec && typeof command === "string"
    ? { kind: "cmd", payload: command }
    : { kind: "json", payload: canonical(input ?? {}) };
}

/**
 * sha256 of the tool name, the payload's kind and the exact payload: the only thing a "session" or "always" grant
 * matches. The three parts are encoded as one JSON array, so none can run into another (M2-RT-24).
 */
export function grantKey(tool: string, payload: GrantPayload): string {
  return createHash("sha256")
    .update(JSON.stringify([tool, payload.kind, payload.payload]))
    .digest("hex");
}
