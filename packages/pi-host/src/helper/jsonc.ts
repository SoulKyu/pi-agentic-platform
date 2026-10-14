/**
 * Pi's models.json tolerance, mirrored exactly (Pi SDK `utils/json.js` `stripJsonComments` and `utils/text.js`
 * `stripBom`, as `ModelConfig.load` applies them): a leading BOM, `//` line comments anywhere outside a string, and a
 * comma before a closing `}` or `]`. Block comments are NOT accepted (Pi rejects them too), and a `//` inside a string
 * value survives. Throws like `JSON.parse` on anything else. `scanJsonc` below is a tokenizer over the same text (it
 * parses nothing: validity stays `parseJsonc`'s call).
 */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match.startsWith('"') ? match : ""))
    .replace(
      /"(?:\\.|[^"\\])*"|,(\s*[}\]])/g,
      (match, tail: string | undefined) => tail ?? (match.startsWith('"') ? match : ""),
    );
}

export const parseJsonc = (text: string): unknown => JSON.parse(stripJsonComments(stripBom(text)));

export class JsoncError extends Error {
  constructor(message: "unterminated string" | "unterminated comment" | "too deep" | "too many tokens") {
    super(message); // a fixed phrase: never a piece of the text, which may hold a secret
    this.name = "JsoncError";
  }
}
export const JSONC_LIMITS = { depth: 64, tokens: 200_000 } as const;

/** One string literal or comment: `start`/`end` include the quotes; `value` is decoded (a comment's is its source). */
export interface JsoncString {
  readonly start: number;
  readonly end: number;
  readonly value: string;
  readonly role: "key" | "value" | "comment";
  /** The object keys above the token (its own key for a value; arrays add nothing, so `["a"]` under `a` stays `a`). */
  readonly path: string[];
  /** Where the token sits, exactly: object keys and array indices from the root. */
  readonly pointer: string[];
}

/** The decoded text of a string literal (quotes included in `raw`); an invalid escape falls back to the raw inside. */
export function decodeJsonString(raw: string): string {
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === "string") return value;
  } catch {
    // an invalid escape: the file is invalid anyway, so the raw text stands in
  }
  return raw.slice(1, -1);
}

interface Frame {
  readonly object: boolean;
  key: string;
  index: number;
}

/** The first character after `from` that is not a space or part of a comment. */
function nextSignificant(text: string, from: number): string | undefined {
  let at = from;
  while (at < text.length) {
    const char = text[at];
    if (char === "/" && text[at + 1] === "/") {
      const newline = text.indexOf("\n", at);
      if (newline === -1) return undefined;
      at = newline;
    } else if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      if (close === -1) return undefined;
      at = close + 2;
    } else if (char !== undefined && /\s/.test(char)) at += 1;
    else return char;
  }
  return undefined;
}

/**
 * Every string literal and comment of a models.json-like text, in order, with Pi's own rules outside strings: `//`
 * runs to the newline, a block comment is skipped (Pi rejects it, so `parseJsonc` will), and nothing inside a string
 * starts a comment. A string is a key when a colon follows it (not by what came before, so a missing comma cannot turn
 * a credential key into a value). Throws `JsoncError` (a fixed phrase) on an unterminated string or comment, over
 * `JSONC_LIMITS.depth` levels or over `JSONC_LIMITS.tokens` tokens.
 */
export function* scanJsonc(text: string): Generator<JsoncString> {
  const stack: Frame[] = [];
  const keysAbove = (own: boolean): string[] => {
    const keys = stack.filter((frame) => frame.object).map((frame) => frame.key);
    return own ? keys : keys.slice(0, -1);
  };
  const pointer = (): string[] => stack.map((frame) => (frame.object ? frame.key : String(frame.index)));
  let tokens = 0;
  const count = (): void => {
    if (++tokens > JSONC_LIMITS.tokens) throw new JsoncError("too many tokens");
  };
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    const top = stack.at(-1);
    if (char === '"') {
      let end = at + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      if (end >= text.length) throw new JsoncError("unterminated string");
      count();
      const value = decodeJsonString(text.slice(at, end + 1));
      const isKey = top?.object === true && nextSignificant(text, end + 1) === ":";
      if (isKey) top.key = value;
      yield {
        start: at,
        end: end + 1,
        value,
        role: isKey ? "key" : "value",
        path: keysAbove(!isKey),
        pointer: pointer(),
      };
      at = end + 1;
    } else if (char === "/" && text[at + 1] === "/") {
      const newline = text.indexOf("\n", at);
      const end = newline === -1 ? text.length : newline;
      count();
      yield {
        start: at,
        end,
        value: text.slice(at, end),
        role: "comment",
        path: keysAbove(true),
        pointer: pointer(),
      };
      at = end;
    } else if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      if (close === -1) throw new JsoncError("unterminated comment");
      count();
      yield {
        start: at,
        end: close + 2,
        value: text.slice(at, close + 2),
        role: "comment",
        path: keysAbove(true),
        pointer: pointer(),
      };
      at = close + 2;
    } else {
      if (char === "{" || char === "[") {
        if (stack.length >= JSONC_LIMITS.depth) throw new JsoncError("too deep");
        stack.push({ object: char === "{", key: "", index: 0 });
      } else if (char === "}" || char === "]") stack.pop();
      else if (char === "," && top !== undefined && !top.object) top.index += 1;
      at += 1;
    }
  }
}
