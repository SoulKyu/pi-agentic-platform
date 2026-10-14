import { parseUrl } from "../../lib/parse-url.ts";

/**
 * The paste importer's parser (M7R101): pure, runs in the browser, never executes or evaluates what it reads, and
 * sends nothing. It turns a pasted mcp.json, a `{ name: entry }` map, one entry, a command line or an https address
 * into candidates the person looks at (masked) before pressing Add. The daemon validates every entry again.
 */
export const IMPORT_LIMITS = { paste: 100_000, servers: 200, depth: 6, name: 64, pairs: 32 } as const;
const MASK = "•••";

export interface Candidate {
  readonly name: string;
  readonly entry: Record<string, unknown>;
}
export interface ImportResult {
  /** Flags of a `claude mcp add` line that were read but not used (shown, so nothing is dropped silently). */
  readonly ignored: string[];
  readonly candidates: Candidate[];
  /** More servers were pasted than `IMPORT_LIMITS.servers`: the rest are dropped. */
  readonly cut: boolean;
  readonly tooLarge: boolean;
}

const NOTHING: ImportResult = { candidates: [], cut: false, tooLarge: false, ignored: [] };
/** The one rule for a server name, shared with the form: the daemon refuses anything else (`bad_request`). */
export const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const RESERVED = new Set(["constructor", "prototype", "__proto__"]);
/** Pi's tool names fold `-` into `_`: `a-b` and `a_b` are the same name for the daemon (`conflict`). */
const namespace = (name: string): string => name.replaceAll("-", "_");
const LAUNCHERS = new Set([
  "npx",
  "bunx",
  "uvx",
  "pipx",
  "uv",
  "node",
  "deno",
  "bun",
  "python",
  "python3",
  "pnpm",
  "yarn",
  "npm",
  "docker",
  "podman",
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A name in the schema's alphabet (letters, digits, `_`, `-`; first a letter or a digit; at most 64): `My Server!` is `My-Server`. */
export function normaliseName(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, IMPORT_LIMITS.name)
    .replace(/[-_]+$/, "");
  if (cleaned === "") return "server";
  return RESERVED.has(cleaned) ? `${cleaned}-server` : cleaned;
}

/** `taken` holds namespaced names. */
function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(namespace(base))) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base.slice(0, IMPORT_LIMITS.name - 1 - String(n).length)}-${n}`;
    if (!taken.has(namespace(candidate))) return candidate;
  }
}

function withinDepth(value: unknown, left: number): boolean {
  if (typeof value !== "object" || value === null) return true;
  if (left <= 0) return false;
  return Object.values(value).every((inner) => withinDepth(inner, left - 1));
}

const hasText = (value: unknown): value is string => typeof value === "string" && value !== "";
const looksLikeEntry = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  (hasText(value.command) || hasText(value.url)) &&
  withinDepth(value, IMPORT_LIMITS.depth);

/** The package a command line names: the first word that is not a flag, minus a version, minus its scope. */
function nameFromCommand(command: string, args: readonly unknown[]): string {
  const word = args.find((arg): arg is string => typeof arg === "string" && !arg.startsWith("-")) ?? command;
  const last = word.split("/").filter(Boolean).pop() ?? word;
  return last.replace(/(?<=.)@[^@]*$/, "");
}

function nameFromUrl(url: string): string {
  return parseUrl(url)?.hostname.split(".")[0] ?? "";
}

function nameOfEntry(entry: Record<string, unknown>): string {
  if (hasText(entry.command))
    return nameFromCommand(entry.command, Array.isArray(entry.args) ? entry.args : []);
  return hasText(entry.url) ? nameFromUrl(entry.url) : "";
}

// ponytail: a backslash escapes the next character (POSIX); a Windows path (C:\\dir) loses its separators. pap runs on Linux.
/** Shell-like words: whitespace splits, single and double quotes group, a backslash escapes. `null`: a quote is left open. */
function words(line: string): string[] | null {
  const out: string[] = [];
  let current = "";
  let started = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const char = line.charAt(i);
    if (quote !== null) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) current += line.charAt(++i);
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (char === "\\" && i + 1 < line.length) {
      current += line.charAt(++i);
      started = true;
    } else if (/\s/.test(char)) {
      if (started) out.push(current);
      current = "";
      started = false;
    } else {
      current += char;
      started = true;
    }
  }
  if (quote !== null) return null;
  if (started) out.push(current);
  return out;
}

const launchable = (word: string | undefined): boolean =>
  word !== undefined && (LAUNCHERS.has(word) || /^(\.{1,2}|~)?\//.test(word));

/** Flags of `claude mcp add` that take a value: the value is never the server's name. */
const VALUE_FLAGS = new Set(["-t", "--transport", "-s", "--scope", "-H", "--header", "-e", "--env"]);
const ENV_FLAGS = new Set(["-e", "--env"]);
const IGNORED_MAX = 8;

interface Found {
  readonly candidates: Candidate[];
  readonly ignored: string[];
}

/** `claude mcp add [flags] <name> [flags] -- <command> [args]`: `-e K=V` becomes env, every other flag is reported. */
function fromClaudeAdd(parts: readonly string[]): Found {
  const split = parts.indexOf("--");
  const [command, ...args] = split === -1 ? [] : parts.slice(split + 1);
  if (command === undefined) return { candidates: [], ignored: [] };
  const env: Record<string, string> = {};
  const ignored = new Set<string>();
  let given: string | undefined;
  const before = parts.slice(3, split);
  for (let i = 0; i < before.length; i++) {
    const word = before[i] ?? "";
    if (!word.startsWith("-")) {
      given ??= word;
      continue;
    }
    const [flag = "", inline] = word.startsWith("--") ? word.split(/=(.*)/s) : [word, undefined];
    const value = inline ?? (VALUE_FLAGS.has(flag) ? before[++i] : undefined);
    const at = value?.indexOf("=") ?? -1;
    if (ENV_FLAGS.has(flag) && value !== undefined && at > 0 && value.slice(0, at) !== "__proto__")
      env[value.slice(0, at)] = value.slice(at + 1);
    else ignored.add(flag.slice(0, 32));
  }
  const entry = {
    command,
    ...(args.length > 0 ? { args } : {}),
    ...(Object.keys(env).length > 0 ? { env } : {}),
  };
  return {
    candidates: [{ name: given ?? nameFromCommand(command, args), entry }],
    ignored: [...ignored].slice(0, IGNORED_MAX),
  };
}

function fromCommandLine(text: string): Found {
  const parts = words(text);
  if (parts === null || parts.length === 0) return { candidates: [], ignored: [] };
  if (parts[0] === "claude" && parts[1] === "mcp" && parts[2] === "add") return fromClaudeAdd(parts);
  const [command, ...args] = parts;
  if (!launchable(command) || command === undefined) return { candidates: [], ignored: [] };
  const entry = args.length === 0 ? { command } : { command, args };
  return { candidates: [{ name: nameFromCommand(command, args), entry }], ignored: [] };
}

function fromAddress(text: string): Candidate[] {
  if (/\s/.test(text) || !/^https:\/\//i.test(text) || parseUrl(text) === null) return [];
  return [{ name: nameFromUrl(text), entry: { url: text } }];
}

function fromJson(text: string): Candidate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!isRecord(parsed)) return [];
  const wrapped = Object.hasOwn(parsed, "mcpServers") ? parsed.mcpServers : undefined;
  if (isRecord(wrapped)) return entriesOf(wrapped);
  if (looksLikeEntry(parsed)) return [{ name: nameOfEntry(parsed), entry: parsed }];
  return entriesOf(parsed);
}

const entriesOf = (map: Record<string, unknown>): Candidate[] =>
  Object.entries(map).flatMap(([name, entry]) => (looksLikeEntry(entry) ? [{ name, entry }] : []));

/** What the person pasted, as servers to add. Over `IMPORT_LIMITS.paste` characters nothing is read at all. */
export function parsePaste(raw: string): ImportResult {
  if (raw.length > IMPORT_LIMITS.paste) return { ...NOTHING, tooLarge: true };
  const text = raw.trim();
  if (text === "") return NOTHING;
  const { candidates: found, ignored }: Found = text.startsWith("{")
    ? { candidates: fromJson(text), ignored: [] }
    : /^https?:\/\//i.test(text)
      ? { candidates: fromAddress(text), ignored: [] }
      : fromCommandLine(text);
  const taken = new Set<string>();
  const candidates = found.slice(0, IMPORT_LIMITS.servers).map(({ name, entry }) => {
    const unique = uniqueName(normaliseName(name), taken);
    taken.add(namespace(unique));
    return { name: unique, entry };
  });
  return { candidates, cut: found.length > IMPORT_LIMITS.servers, tooLarge: false, ignored };
}

export interface Pair {
  readonly name: string;
  readonly value: typeof MASK;
}
export interface Preview {
  readonly kind: "stdio" | "http";
  readonly target: string;
  readonly env: Pair[];
  readonly headers: Pair[];
}

const SECRET_FLAG = /token|key|secret|pass|auth|cred|header/i;
const isSecretFlag = (flag: string): boolean => flag === "-H" || SECRET_FLAG.test(flag);
/** `scheme://user:pw@host` -> `scheme://•••@host`. */
const hideUserinfo = (word: string): string => word.replace(/(:\/\/)[^/\s@]+@/g, `$1${MASK}@`);
const SECRET_SHAPE = /^(sk-|ghp_|gho_|github_pat_|xox[a-z]-|AKIA|eyJ|Bearer\s)|^[A-Za-z0-9_+=.-]{32,}$/;

function maskWords(list: readonly unknown[]): string {
  let afterSecretFlag = false;
  return list
    .map((word) => {
      if (typeof word !== "string") return MASK;
      const hidden = afterSecretFlag || SECRET_SHAPE.test(word);
      afterSecretFlag = false;
      if (hidden) return MASK;
      if (word.startsWith("-")) {
        const [flag = "", ...value] = word.split("=");
        if (isSecretFlag(flag)) {
          if (value.length > 0) return `${flag}=${MASK}`;
          afterSecretFlag = true;
        }
      }
      return hideUserinfo(word);
    })
    .join(" ");
}

function maskUrl(url: string): string {
  const parsed = parseUrl(url);
  if (parsed === null) return MASK;
  const path = parsed.pathname
    .split("/")
    .map((part) => (SECRET_SHAPE.test(part) ? MASK : part))
    .join("/");
  const userinfo = parsed.username !== "" || parsed.password !== "" ? `${MASK}@` : "";
  return `${parsed.protocol}//${userinfo}${parsed.host}${path}${parsed.search === "" ? "" : `?${MASK}`}`;
}

const pairsOf = (value: unknown): Pair[] =>
  isRecord(value)
    ? Object.keys(value)
        .slice(0, IMPORT_LIMITS.pairs)
        .map((name) => ({ name: name.slice(0, IMPORT_LIMITS.name), value: MASK }))
    : [];

/** The entry as the screen shows it before Add: every env and header value is `•••`, secret-looking words and address parts too. */
export function previewOf(entry: Record<string, unknown>): Preview {
  const http = hasText(entry.url) && !hasText(entry.command);
  const target = http
    ? maskUrl(String(entry.url))
    : maskWords([entry.command, ...(Array.isArray(entry.args) ? entry.args : [])]);
  return {
    kind: http ? "http" : "stdio",
    target: target.length > 500 ? `${target.slice(0, 499)}…` : target,
    env: pairsOf(entry.env),
    headers: pairsOf(entry.headers),
  };
}
