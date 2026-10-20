const QUOTE = 0x22;
const BACKSLASH = 0x5c;

/** Index just past the string literal that starts at `from` (a quote), or -1 when it never ends. */
function endOfString(text: string, from: number): number {
  for (let i = from + 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === BACKSLASH) i++;
    else if (code === QUOTE) return i + 1;
  }
  return -1;
}

const isSpace = (code: number): boolean => code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;

/**
 * True when the top-level object of an already valid JSON text holds `name` as a key more than once. `JSON.parse` keeps the
 * last of two equal keys, but another reader (the provider) may keep the first: a body that is read two ways is refused (T12).
 * Keys are compared decoded, so `"model"` is `model`. Nested objects and string values are skipped, never counted.
 */
export function hasDuplicateTopLevelKey(body: Buffer, name: string): boolean {
  const text = body.toString("utf8");
  let i = 0;
  while (i < text.length && isSpace(text.charCodeAt(i))) i++;
  if (text[i] !== "{") return false;
  i++;
  let seen = 0;
  let depth = 0;
  // A key is a string at depth 0 right after the opening brace or a comma (a comma deeper only arms it for the depth check).
  let expectKey = true;
  while (i < text.length) {
    const char = text[i] as string;
    if (char === '"') {
      const end = endOfString(text, i);
      if (end < 0) return false;
      if (depth === 0 && expectKey) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(i, end));
        } catch {
          return false;
        }
        if (key === name && ++seen > 1) return true;
        expectKey = false;
      }
      i = end;
      continue;
    }
    if (char === "{" || char === "[") depth++;
    else if (char === "}" || char === "]") {
      depth--;
      if (depth < 0) return false;
    } else if (char === ",") expectKey = true;
    i++;
  }
  return false;
}
