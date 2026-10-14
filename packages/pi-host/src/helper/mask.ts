/**
 * Word-by-word masking of what an MCP entry may carry in its command, arguments and URL (M7R83). Nothing here parses a
 * file or resolves a variable: a word is kept, or it becomes `MASK`.
 */
import { credentialName } from "./credential-words.ts";

export const MASK = "•••";
// Credential names are the shared vocabulary (MC40). Only these two query names are credentials by their exact spelling.
const QUERY_NAME = /^(?:code|sig)$/i;
const PLACEHOLDER = /^(?:\$\{[A-Za-z_][A-Za-z0-9_]*\}|\$[A-Z_][A-Z0-9_]*)$/;
const SCHEME_WORD = /^(?:Bearer|Basic|Token)$/i;
const FLAG = /^-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*$/;
const FLAG_VALUE = /^(-{1,2}[A-Za-z0-9][A-Za-z0-9_-]*)=(.*)$/s;
const PAIR = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const HEADER = /^([A-Za-z0-9-]+):\s*(.+)$/s;
// A header name alone, its value in the next word (`-H X-Api-Key: abc` without quotes).
const HEADER_NAME = /^[A-Za-z0-9-]+:$/;
const URL_START = /^[a-z][a-z0-9+.-]*:\/\//i;
const URL_USERINFO = /^([a-z][a-z0-9+.-]*:\/\/)[^/?#\s]*@/i;
// A fragment's parts: a `name=value` parameter (the name stops at a route character, the value at the next
// parameter) or a bare piece of the route.
const FRAGMENT_PART = /([^&=?#/]*)=([^&#]*)|[^&=?#/]+/g;
// A value inside a value, or quoting nested deeper than this, is hidden whole instead of read.
const MAX_DEPTH = 8;

/** A value that looks like a credential: long, URL-safe characters, letters and digits. */
export const tokenLike = (value: string): boolean =>
  value.length >= 24 && /^[A-Za-z0-9_\-.~+/=]+$/.test(value) && /[A-Za-z]/.test(value) && /\d/.test(value);
const keep = (value: string): boolean => PLACEHOLDER.test(value);

const decodeURIComponentSafe = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/** A path segment: a token-like one is hidden, a variable stays readable (`new URL` would have written `%7B`). */
function maskSegment(segment: string): string {
  const decoded = decodeURIComponentSafe(segment);
  if (tokenLike(decoded)) return MASK;
  return keep(decoded) ? decoded : segment;
}

/** A query or fragment parameter is hidden for a credential name, `code`, `sig` or a token-like value. */
const hiddenParam = (name: string, value: string): boolean =>
  !keep(value) && (credentialName(name) || QUERY_NAME.test(name) || tokenLike(value));

function maskParams(params: URLSearchParams): string {
  return [...params]
    .map(([name, value]) => {
      const shown = hiddenParam(name, value) ? MASK : keep(value) ? value : encodeURIComponent(value);
      return `${encodeURIComponent(name)}=${shown}`;
    })
    .join("&");
}

/**
 * A fragment, masked in place (`#/cb?code=abc` keeps its route, `#q=a+b` its encoding): a token-like whole goes, then
 * each parameter as in a query and each token-like piece of the route.
 */
function maskFragment(fragment: string): string {
  if (tokenLike(decodeURIComponentSafe(fragment))) return MASK;
  return fragment.replace(FRAGMENT_PART, (part, name: string | undefined, value: string | undefined) => {
    if (name === undefined || value === undefined)
      return tokenLike(decodeURIComponentSafe(part)) ? MASK : part;
    return `${name}=${hiddenParam(decodeURIComponentSafe(name), decodeURIComponentSafe(value)) ? MASK : value}`;
  });
}

/** M7R83: userinfo, credential-named query values, token-like path segments, query values and fragments. */
export function maskUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Not a URL (a variable as its host, say): the user information still goes, and a token-like whole text too.
    return tokenLike(raw) ? MASK : raw.replace(URL_USERINFO, `$1${MASK}@`);
  }
  const userinfo = url.username !== "" || url.password !== "" ? `${MASK}@` : "";
  const path = url.pathname.split("/").map(maskSegment).join("/");
  const query = maskParams(url.searchParams);
  const hash = url.hash === "" ? "" : `#${maskFragment(url.hash.slice(1))}`;
  return `${url.protocol}//${userinfo}${url.host}${path}${query === "" ? "" : `?${query}`}${hash}`;
}

/**
 * The words of a command line as a POSIX shell splits them: quotes group words and are removed, and a backslash
 * escapes the next character (inside double quotes only `"`, `\`, `$` and a backquote). An open quote runs to the end.
 */
export function commandWords(line: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  let quote = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i] as string;
    if (quote === "" && /\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
      continue;
    }
    word ??= "";
    const next = line[i + 1];
    if (char === quote) quote = "";
    else if (quote === "" && (char === "'" || char === '"')) quote = char;
    else if (
      char === "\\" &&
      next !== undefined &&
      (quote === "" || (quote === '"' && '"\\$`'.includes(next)))
    ) {
      word += next;
      i += 1;
    } else word += char;
  }
  if (word !== null) words.push(word);
  return words;
}

/** Shown words joined by spaces; one that holds a space (or nothing) is quoted, so the word boundaries stay visible. */
export const joinWords = (words: readonly string[]): string =>
  words
    .map((word) => (word !== "" && !/\s/.test(word) ? word : word.includes("'") ? `"${word}"` : `'${word}'`))
    .join(" ");

/** M7R83: one argument list, word by word; a credential flag or header name, or `Bearer`, hides the next word. */
export const maskArgs = (args: readonly string[]): string[] => maskWords(args, 0);

/** A whole command line in one string (`sh -c "npx s --token abc"`): split as a shell would, masked word by word. */
export const maskCommandLine = (command: string): string => maskLine(command, 0);

const maskLine = (line: string, depth: number): string => joinWords(maskWords(commandWords(line), depth));
const deeper = (depth: number, mask: (next: number) => string): string =>
  depth >= MAX_DEPTH ? MASK : mask(depth + 1);

function maskWords(args: readonly string[], depth: number): string[] {
  const out: string[] = [];
  let hideNext = false;
  for (const arg of args) {
    if (hideNext) {
      // `Authorization: Bearer abc` in three words: the scheme stays readable and hides the word after it.
      hideNext = SCHEME_WORD.test(arg);
      out.push(keep(arg) || hideNext ? arg : MASK);
      continue;
    }
    // A word with a space is a line, not a URL: `new URL` would percent-encode the space and hide the words after it.
    if (URL_START.test(arg) && !/\s/.test(arg)) {
      out.push(maskUrl(arg));
      continue;
    }
    const flag = FLAG_VALUE.exec(arg);
    if (flag && credentialName(flag[1] as string)) {
      out.push(keep(flag[2] as string) ? arg : `${flag[1]}=${MASK}`);
      continue;
    }
    const pair = PAIR.exec(arg);
    if (pair && credentialName(pair[1] as string)) {
      out.push(keep(pair[2] as string) ? arg : `${pair[1]}=${MASK}`);
      continue;
    }
    // Any other `--flag=value` or `NAME=value`: the value is read as an argument of its own (a URL, a header, a pair,
    // several words), unless the whole word looks like a token (a padded base64 token parses as `name=`).
    const named = flag ?? pair;
    if (named) {
      const value = named[2] as string;
      out.push(
        tokenLike(arg)
          ? MASK
          : `${named[1]}=${deeper(depth, (next) => maskWords([value], next)[0] as string)}`,
      );
      continue;
    }
    const header = HEADER.exec(arg);
    if (header && credentialName(header[1] as string)) {
      out.push(`${header[1]}: ${MASK}`);
      continue;
    }
    // Several words in one argument (`sh -c "npx s --api-key sk-..."`, `Bearer sk-...`) or a quoted one: a command line.
    if (/\s/.test(arg) || /^['"]/.test(arg)) {
      out.push(deeper(depth, (next) => maskLine(arg, next)));
      continue;
    }
    if (
      ((FLAG.test(arg) || HEADER_NAME.test(arg)) && credentialName(arg)) ||
      arg === "-k" ||
      SCHEME_WORD.test(arg)
    ) {
      out.push(arg);
      hideNext = true;
      continue;
    }
    // A leading `$` is not part of a secret's alphabet, but `$ecret...` is no variable either (those are capitals).
    out.push(tokenLike(arg.startsWith("$") ? arg.slice(1) : arg) && !keep(arg) ? MASK : arg);
  }
  return out;
}
