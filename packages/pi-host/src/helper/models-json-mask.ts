import { COMMENT_WORD, credentialName } from "./credential-words.ts";
import { scanJsonc, type JsoncString } from "./jsonc.ts";

const REFERENCE = /^(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{[A-Za-z_][A-Za-z0-9_]*\})$/;
const PLACEHOLDER = /^<redacted:(\d{1,4})>$/;
const QUOTED_PLACEHOLDER = /"<redacted:(\d{1,4})>"/g;
/** `https://user:password@host`: the user information is a credential. */
const USERINFO = /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i;
const COMMENT = "comment";
export const MAX_SECRETS = 1000;

/** Whether a string value is a literal secret (M7R62): under a credential name or `headers`, or a URL with user information; never a reference or a command. */
function secretValue(token: JsoncString): boolean {
  if (token.role !== "value") return false;
  // Any name above counts, so a credential name holding an object or an array masks what is inside it.
  const credential =
    token.path.some((key) => credentialName(key) || key.toLowerCase() === "headers") ||
    USERINFO.test(token.value);
  return credential && !REFERENCE.test(token.value) && !token.value.startsWith("!");
}

/**
 * One line of a comment: from right after the first credential word (inside its identifier) to the end of the line
 * becomes a placeholder. Only a whole quoted value that is a reference or a command is kept (`"$NAME"`, `"!op read x"`),
 * or an unquoted reference; a value that merely starts with a bang is not a command here, and a quote inside the
 * quoted value ends the kept part (`"!op read x" "sk-abc"` is masked).
 */
function redactLine(line: string, take: (original: string) => string): string {
  const found = COMMENT_WORD.exec(line);
  if (found === null) return line;
  const cut = found.index + found[0].length;
  const tail = line.slice(cut);
  const value = tail.replace(/^["']?\s*[:=]?\s*/, "").replace(/[\s,;]+$/, "");
  const quoted = /^(["'])((?:(?!\1).)*)\1$/.exec(value);
  const kept =
    quoted === null
      ? REFERENCE.test(value)
      : REFERENCE.test(quoted[2] ?? "") || (quoted[2] ?? "").startsWith("!");
  if (value === "" || kept) return line;
  return line.slice(0, cut) + take(tail);
}

/** A comment's credential tails redacted line by line; a block comment keeps its closing marker. */
function redactComment(source: string, take: (original: string) => string): string {
  const closed = source.startsWith("/*") && source.endsWith("*/") && source.length >= 4;
  const body = closed ? source.slice(0, -2) : source;
  return (
    body
      .split("\n")
      .map((line) => redactLine(line, take))
      .join("\n") + (closed ? "*/" : "")
  );
}

export interface MaskedModelsJson {
  readonly masked: string;
  /** The raw literal (JSON text, escapes kept) or comment tail behind each placeholder, by number. */
  readonly secrets: string[];
  /** Where each came from: its exact key path (JSON), or `comment`. A secret goes back only there. */
  readonly places: string[];
}

/** M7R62: every literal secret becomes `"<redacted:N>"`, N counting from 0 in document order. */
export function maskModelsJson(text: string): MaskedModelsJson {
  const secrets: string[] = [];
  const places: string[] = [];
  const take = (original: string, where: string): string => {
    if (secrets.length >= MAX_SECRETS) throw new RangeError("too many secrets");
    secrets.push(original);
    places.push(where);
    return `"<redacted:${secrets.length - 1}>"`;
  };
  let masked = "";
  let at = 0;
  for (const token of scanJsonc(text)) {
    let replacement: string;
    if (token.role === "comment")
      replacement = redactComment(token.value, (original) => take(original, COMMENT));
    else if (secretValue(token))
      replacement = take(text.slice(token.start, token.end), JSON.stringify(token.pointer));
    else continue;
    masked += text.slice(at, token.start) + replacement;
    at = token.end;
  }
  return { masked: masked + text.slice(at), secrets, places };
}

/**
 * Puts each original back where the new text holds its exact placeholder, and only there (MC32): a value at the key
 * path it was masked at, or a comment that would hide it again. A placeholder that is unknown, used twice or moved
 * answers `{ refused }` with the offset of the placeholder in `text`. Throws `RangeError` past `max` characters.
 */
export function unmaskModelsJson(
  text: string,
  secrets: readonly string[],
  places: readonly string[],
  max = Number.POSITIVE_INFINITY,
): string | { refused: number } {
  const used = new Set<number>();
  let out = "";
  let at = 0;
  for (const token of scanJsonc(text)) {
    let replacement: string;
    if (token.role === "comment") {
      const restored: number[] = [];
      let bad = false;
      replacement = token.value.replace(QUOTED_PLACEHOLDER, (whole: string, n: string) => {
        const k = Number(n);
        if (secrets[k] === undefined || places[k] !== COMMENT || used.has(k)) {
          bad = true;
          return whole;
        }
        used.add(k);
        restored.push(k);
        return secrets[k];
      });
      if (bad) return { refused: token.start };
      if (restored.length === 0) continue;
      // The restored comment must hide those secrets again, or a move into a plain note would show them.
      const hidden: string[] = [];
      redactComment(replacement, (original) => (hidden.push(original), '"<redacted:0>"'));
      if (!restored.every((k) => hidden.includes(secrets[k] ?? ""))) return { refused: token.start };
    } else {
      const match = token.role === "value" ? PLACEHOLDER.exec(token.value) : null;
      if (match === null) continue;
      const k = Number(match[1]);
      const original = secrets[k];
      if (original === undefined || used.has(k) || places[k] !== JSON.stringify(token.pointer))
        return { refused: token.start };
      used.add(k);
      replacement = original;
    }
    out += text.slice(at, token.start) + replacement;
    at = token.end;
    if (out.length > max) throw new RangeError("too large");
  }
  out += text.slice(at);
  if (out.length > max) throw new RangeError("too large");
  return out;
}
