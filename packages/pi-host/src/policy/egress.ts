import type { CallFacts, StageResult } from "./pipeline.ts";
import { argvOf, CommandTooComplex, CommandTooLong, readCommands } from "./shell-words.ts";

export const EGRESS_MODEL_REASON =
  "pap-policy blocked this call: it reaches a web host that is not on the allowed list.";
const MCP_READ_ONLY = "MCP tool that is not read-only";
const MCP_READ_ONLY_MODEL_REASON =
  "pap-policy blocked this call: the session is read-only and this MCP tool may change things.";
const TOO_COMPLEX = "input too complex for the egress check";
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const URL_START = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;
// WHATWG forgives a missing `//` after these schemes and drops tab, LF and CR anywhere (`https:evil.test`, `https:/\t/evil.test`).
const URL_NO_SLASHES = /^(?:https?|wss?|ftp|file):(?! |$)/i;
const NESTED_SCHEME = /[a-z][a-z0-9+.-]{0,31}:\/\//gi;
const HOST_ALPHABET = /^[a-z0-9-]+(?:\.[a-z0-9-]+)*$/;
const DEV_NET = /^\/dev\/(?:tcp|udp)\//;
const CURL_REROUTE: ReadonlySet<string> = new Set([
  "-x",
  "--proxy",
  "--preproxy",
  "--connect-to",
  "--resolve",
  "--socks4",
  "--socks4a",
  "--socks5",
  "--socks5-hostname",
  "--doh-url",
  "--proxy1.0",
  "--dns-servers",
]);
const CURL_LONG_REROUTE = [...CURL_REROUTE].filter((flag) => flag.startsWith("--"));
// These two send the request to another address whatever their value is.
const CURL_ALWAYS_REROUTE: ReadonlySet<string> = new Set(["--connect-to", "--resolve"]);
const GIT_VALUED_OPTIONS: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--attr-source",
  "--shallow-file",
]);
// Linear: a scheme of at most 32 characters, then everything up to a blank, a quote or an angle bracket (M5R22).
const URL_IN_TEXT = /[a-z][a-z0-9+.-]{0,31}:\/\/[^\s"'<>]+/gi;
const TRAILING: ReadonlySet<string> = new Set([")", ".", ",", ";", ":", "!", "?", "]", "}"]);
const MAX_DEPTH = 10;
const MAX_STRINGS = 10_000;
const MAX_NODES = 100_000;
const MAX_URLS = 10_000;
const MAX_JSON_STRING = 1024 * 1024;
const ALWAYS_NETWORK: ReadonlySet<string> = new Set([
  "curl",
  "wget",
  "nc",
  "ncat",
  "socat",
  "ssh",
  "sftp",
  "ftp",
  "telnet",
  "dig",
  "nslookup",
  "host",
]);
const GIT_NETWORK: ReadonlySet<string> = new Set(["clone", "fetch", "pull", "push", "ls-remote"]);
export class EgressInputTooComplex extends Error {}

export function judgeUrl(
  raw: string,
  allow: readonly string[],
): { ok: true; host: string } | { ok: false; why: string } {
  if (/[\\\s\p{Cc}\p{Cf}]/u.test(raw)) return { ok: false, why: "unreadable URL" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, why: "unreadable URL" };
  }
  if (url.protocol === "file:" && url.hostname === "") return { ok: true, host: "" };
  if (!NETWORK_PROTOCOLS.has(url.protocol)) return { ok: false, why: `${url.protocol.slice(0, 16)} URL` };
  if (url.username !== "" || url.password !== "") return { ok: false, why: "credentials in URL" };
  const host = url.hostname.replace(/\.$/, "");
  if (host.startsWith("[") || /^(?:\d+\.){3}\d+$/.test(host)) return { ok: false, why: "IP address" };
  // The alphabet of a `HostPattern`: a host built from `$H`, `${H}`, a quote or an empty label never matches a `*.` entry.
  if (!HOST_ALPHABET.test(host)) return { ok: false, why: "unreadable URL" };
  const allowed = allow.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );
  return allowed ? { ok: true, host } : { ok: false, why: `web host not allowed: ${host.slice(0, 200)}` };
}

function push(out: string[], url: string): void {
  if (out.length >= MAX_URLS) throw new EgressInputTooComplex("too many URLs");
  out.push(url);
}

function pushTrimmed(out: string[], piece: string): void {
  let end = piece.length;
  while (end > 0 && TRAILING.has(piece[end - 1] ?? "")) end--;
  push(out, piece.slice(0, end));
}

/** WHATWG drops leading and trailing C0 controls and spaces before it parses. */
function trimC0(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charCodeAt(start) <= 0x20) start++;
  while (end > start && value.charCodeAt(end - 1) <= 0x20) end--;
  return value.slice(start, end);
}

/** The pieces of a URL-like text that each start at a `scheme://` after `body` (touching URLs: `…/a|https://evil.test/b`). */
function pieces(text: string, body: number): string[] {
  const starts = [0];
  for (const nested of text.slice(body).matchAll(NESTED_SCHEME)) starts.push(body + nested.index);
  return starts.map((start, i) => text.slice(start, starts[i + 1]));
}

/** The URL a trimmed text is whole, as `scheme://…` or in the WHATWG form without slashes; cut at the first space. */
function wholeUrl(text: string): { url: string; body: number } | null {
  if (URL_START.test(text)) return text.includes(" ") ? null : { url: text, body: text.indexOf("://") + 3 };
  if (!URL_NO_SLASHES.test(text.replace(/[\t\n\r]/g, ""))) return null;
  const url = text.includes(" ") ? text.slice(0, text.indexOf(" ")) : text;
  return { url, body: url.indexOf(":") + 1 };
}

/**
 * A string that is one URL is judged whole, plus any URL that starts inside it; free text is scanned for URL substrings,
 * each cut where the next `scheme://` starts (M5R22). The form without `//` (`https:evil.test`) is read up to the first
 * space; free text with such a scheme in the middle (`see https:evil.test`) is a documented pass.
 */
export function urlsInString(value: string, out: string[]): void {
  const text = trimC0(value.trim());
  const whole = wholeUrl(text);
  if (whole) {
    push(out, whole.url);
    for (const piece of pieces(whole.url, whole.body).slice(1)) pushTrimmed(out, piece);
    // The no-`//` form is read up to its first space; what follows is free text.
    if (!text.includes(" ")) return;
  }
  if (!text.includes("://")) return;
  for (const match of text.matchAll(URL_IN_TEXT))
    for (const piece of pieces(match[0], match[0].indexOf("://") + 3)) pushTrimmed(out, piece);
}

// An alias may run any command, a proxy setting sends git elsewhere: the list can read neither.
const isUnreadableSetting = (setting: string | undefined) => /^(?:alias\.|[^=]*proxy=)/i.test(setting ?? "");

/** The subcommand, and whether a `-c` / `--config-env` before it defines an alias or a proxy. */
function gitScan(rest: readonly string[]): { subcommand: string | undefined; alias: boolean } {
  let alias = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? "";
    if (word === "-c" || word === "--config-env") alias ||= isUnreadableSetting(rest[i + 1]);
    else if (word.startsWith("--config-env=")) alias ||= isUnreadableSetting(word.slice(13));
    if (GIT_VALUED_OPTIONS.has(word)) i++;
    else if (!word.startsWith("-")) return { subcommand: word, alias };
  }
  return { subcommand: undefined, alias };
}

/** A command that reaches another host by itself (M5R118). */
export function reachesNetwork(argv: readonly string[]): boolean {
  const [command = "", ...rest] = argv;
  if (ALWAYS_NETWORK.has(command)) return true;
  if (command === "git") return GIT_NETWORK.has(gitScan(rest).subcommand ?? "");
  if (command === "scp" || command === "rsync")
    return rest.some((word) => !word.startsWith("-") && /^[^/]*:/.test(word));
  return false;
}

interface Counters {
  strings: number;
  nodes: number;
}

/** Objects' own enumerable values and arrays' items; a cycle ends at the depth bound. */
function walk(value: unknown, depth: number, counters: Counters, out: string[], inJson: boolean): void {
  if (depth > MAX_DEPTH || ++counters.nodes > MAX_NODES) throw new EgressInputTooComplex("too deep or wide");
  if (typeof value === "string") {
    if (++counters.strings > MAX_STRINGS) throw new EgressInputTooComplex("too many strings");
    const text = value.trim();
    if (!inJson && (text.startsWith("{") || text.startsWith("["))) {
      if (text.length > MAX_JSON_STRING) throw new EgressInputTooComplex("JSON string too long");
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return urlsInString(value, out);
      }
      // Parsed once: the strings inside are text, never parsed again.
      return walk(parsed, depth + 1, counters, out, true);
    }
    return urlsInString(value, out);
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) for (const item of value) walk(item, depth + 1, counters, out, inJson);
  else
    for (const [key, item] of Object.entries(value)) {
      walk(key, depth + 1, counters, out, inJson);
      walk(item, depth + 1, counters, out, inJson);
    }
}

/** `git -c alias.p=push p origin`, `git -c http.proxy=evil:80 fetch`. */
const definesGitAlias = (argv: readonly string[]): boolean =>
  argv[0] === "git" && gitScan(argv.slice(1)).alias;

/** `curl -x proxy:8080 https://example.com`: a flag that sends the request elsewhere, with a value that is no judged URL. */
function reroutesCurl(argv: readonly string[]): boolean {
  if (argv[0] !== "curl") return false;
  for (let i = 1; i < argv.length; i++) {
    const word = argv[i] ?? "";
    let value: string | undefined;
    const name = word.startsWith("--") && word.includes("=") ? word.slice(0, word.indexOf("=")) : word;
    // curl takes a unique prefix of a long option for the option (`--preprox`, `--resolv`); here any prefix counts.
    const flag =
      name.length >= 5 && name.startsWith("--")
        ? CURL_LONG_REROUTE.find((f) => f.startsWith(name))
        : undefined;
    if (flag !== undefined && CURL_ALWAYS_REROUTE.has(flag)) return true;
    if (/^-[a-zA-Z]*x$/.test(word)) value = argv[i + 1];
    else if (flag !== undefined) value = name === word ? argv[i + 1] : word.slice(word.indexOf("=") + 1);
    else if (/^-[a-wyzA-Z]*x./.test(word)) value = word.slice(word.indexOf("x") + 1);
    else continue;
    // Judged only when the whole value is one URL: `evil.test:80/https://example.com` is a host with a URL in its path.
    const trimmed = trimC0((value ?? "").trim());
    if (wholeUrl(trimmed)?.url !== trimmed) return true;
  }
  return false;
}

/** The first client that cannot be judged: reader errors (too long, too complex) are mapped to a block by the stage. */
function urlsOfCommand(command: string, out: string[]): string | null {
  let uncheckable: string | null = null;
  for (const segment of readCommands(command)) {
    let counted = 0;
    segment.words.forEach((word, i) => {
      const before = out.length;
      urlsInString(word, out);
      // A redirection target is a file or a here-string: judged, but it does not make the client checkable.
      if (!segment.operators.has(i - 1)) counted += out.length - before;
    });
    const argv = argvOf(segment);
    if (uncheckable !== null) continue;
    const device = segment.words.map((word) => DEV_NET.exec(word.replace(/\/+/g, "/"))?.[0]).find(Boolean);
    if (device) uncheckable = device.slice(0, -1);
    else if (reroutesCurl(argv) || definesGitAlias(argv) || (counted === 0 && reachesNetwork(argv)))
      uncheckable = argv[0] ?? null;
  }
  return uncheckable;
}

/** Every URL a call carries (deduplicated, in order of first appearance) and the first network client without one. */
export function urlsOf(call: CallFacts): { urls: string[]; uncheckable: string | null } {
  const { kind, event } = call;
  const out: string[] = [];
  let uncheckable: string | null = null;
  if (!(kind.builtin && (kind.category === "read" || kind.category === "edit"))) {
    const command = (event.input as { command?: unknown } | null)?.command;
    if (typeof command === "string" && (call.exec || !kind.builtin))
      uncheckable = urlsOfCommand(command, out);
    // A built-in shell call with a command is that command alone; every other call is walked whole, a `command` field included.
    if (!(call.exec && typeof command === "string"))
      walk(event.input, 0, { strings: 0, nodes: 0 }, out, false);
  }
  return { urls: [...new Set(out)], uncheckable };
}

const block = (reason: string): StageResult => ({
  outcome: "block",
  reason,
  modelReason: EGRESS_MODEL_REASON,
});

/** Stage 02 (M5R21 to M5R24, M5R118): a reason carries the judged host or scheme (clipped) or a fixed client name, nothing else of the input. */
export function egressStage(call: CallFacts): StageResult {
  if (call.rules.approvalMode === "read-only" && call.kind.mcp && call.kind.category !== "read")
    return { outcome: "block", reason: MCP_READ_ONLY, modelReason: MCP_READ_ONLY_MODEL_REASON };
  const allow = call.rules.allowHosts;
  if (allow === null) return { outcome: "skip", reason: "no egress list" };
  if (!call.kind.urlBearing) return { outcome: "skip", reason: "no URL-bearing input" };
  let found: ReturnType<typeof urlsOf>;
  try {
    found = urlsOf(call);
  } catch (error) {
    if (
      error instanceof EgressInputTooComplex ||
      error instanceof CommandTooComplex ||
      error instanceof CommandTooLong
    )
      return block(TOO_COMPLEX);
    throw error;
  }
  if (found.uncheckable !== null) return block(`host not checkable: ${found.uncheckable}`);
  if (found.urls.length === 0) return { outcome: "pass", reason: "no URL" };
  for (const url of found.urls) {
    const verdict = judgeUrl(url, allow);
    if (!verdict.ok) return block(verdict.why);
  }
  return { outcome: "pass", reason: `${found.urls.length} URL${found.urls.length === 1 ? "" : "s"} allowed` };
}
