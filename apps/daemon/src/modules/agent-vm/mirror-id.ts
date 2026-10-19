import { ENTRY_ID } from "./mirror-line.ts";

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const MAX_KEY = 3;
const MAX_VALUE = 130;

type Mode =
  | "start" // before the object's `{`
  | "key" // inside depth 1, waiting for a key or `}`
  | "colon" // a top-level key was read, waiting for `:`
  | "value" // after `:` at depth 1, waiting for the value's first byte
  | "rest"; // in a value, until the next `,` or `}` at depth 1

/** A line's top-level `id`, found without parsing it. Feed it the line in blocks, then ask for the result. */
export interface IdScanner {
  feed(bytes: Buffer): void;
  /** The value of the single top-level `id` key, or null: no such key, two of them, an escaped key, or a value that is not an `ENTRY_ID` string. */
  result(): string | null;
}

/**
 * AVM-E27: the id of one JSON line as `JSON.parse` would read it, from a byte state machine of constant memory. It tracks
 * depth and string state (a string body is skipped with `indexOf` and a backslash-parity check, so a base64 image is one jump),
 * so an `id` nested in `data` is never taken, wherever the top-level key sits. It answers null whenever it cannot be sure the
 * parse would agree: a key with an escape (it could spell `id`), a second top-level `id` (JSON.parse keeps the last), a value
 * that is not a plain id string. The caller compares it with the id the parse gave.
 */
export function createIdScanner(): IdScanner {
  let mode: Mode = "start";
  let depth = 0;
  let inString = false;
  /** Backslashes directly before the end of the last block while inside a string (parity decides an escaped quote). */
  let carry = 0;
  let capture: "key" | "value" | null = null;
  let captured = "";
  let overflow = false;
  let escapedKey = false;
  let keyIsId = false;
  let idCount = 0;
  let id: string | null = null;
  let poisoned = false;

  const startString = (): void => {
    inString = true;
    carry = 0;
    captured = "";
    overflow = false;
    escapedKey = false;
    if (depth === 1 && mode === "key") capture = "key";
    else if (depth === 1 && mode === "value" && keyIsId) capture = "value";
    else capture = null;
  };
  const endString = (): void => {
    inString = false;
    if (capture === "key") {
      if (escapedKey) poisoned = true;
      keyIsId = !escapedKey && !overflow && captured === "id";
      if (keyIsId && ++idCount > 1) poisoned = true;
      mode = "colon";
    } else if (capture === "value") {
      if (escapedKey || overflow || !ENTRY_ID.test(captured)) poisoned = true;
      else id = captured;
      mode = "rest";
    } else if (depth === 1 && mode === "value") mode = "rest";
    capture = null;
  };
  const take = (piece: Buffer): void => {
    if (capture === null) return;
    if (piece.includes(BACKSLASH)) escapedKey = true;
    if (captured.length + piece.length > (capture === "key" ? MAX_KEY : MAX_VALUE)) overflow = true;
    else captured += piece.toString("latin1");
  };

  const feedString = (bytes: Buffer, from: number): number => {
    for (let at = from; ;) {
      const quote = bytes.indexOf(QUOTE, at);
      const end = quote < 0 ? bytes.length : quote;
      let run = 0;
      while (run < end - at && bytes[end - 1 - run] === BACKSLASH) run++;
      // The run of backslashes right before a quote decides whether it is escaped; one that reaches the block's start continues the last block's.
      const total = run === end - at ? run + carry : run;
      if (quote < 0) {
        take(bytes.subarray(at, end));
        carry = total;
        return bytes.length;
      }
      if (total % 2 === 0) {
        take(bytes.subarray(at, quote));
        endString();
        return quote + 1;
      }
      take(bytes.subarray(at, quote + 1));
      carry = 0;
      at = quote + 1;
    }
  };

  return {
    feed(bytes) {
      for (let at = 0; at < bytes.length;) {
        if (inString) {
          at = feedString(bytes, at);
          continue;
        }
        const byte = bytes[at++] as number;
        if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) continue;
        if (mode === "start") {
          if (byte === 0x7b) {
            depth = 1;
            mode = "key";
          } else poisoned = true;
          continue;
        }
        if (byte === QUOTE) {
          startString();
          continue;
        }
        if (mode === "colon") {
          if (byte === 0x3a) mode = "value";
          continue;
        }
        if (mode === "value") {
          // A value that starts with anything but a quote is not an id string.
          if (keyIsId) poisoned = true;
          mode = "rest";
        }
        if (byte === 0x7b || byte === 0x5b) depth++;
        else if (byte === 0x7d || byte === 0x5d) depth--;
        else if (byte === 0x2c && depth === 1) mode = "key";
      }
    },
    result: () => (poisoned || idCount !== 1 ? null : id),
  };
}

/** The top-level id of one whole line (see `createIdScanner`). */
export function topLevelIdOf(line: Buffer): string | null {
  const scanner = createIdScanner();
  scanner.feed(line);
  return scanner.result();
}
