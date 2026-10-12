import type { CallFacts, StageResult } from "./pipeline.ts";
import { argvOf, CommandTooComplex, CommandTooLong, readCommands } from "./shell-words.ts";

export const EGRESS_MODEL_REASON =
  "pap-policy blocked this call: it reaches a web host that is not on the allowed list.";
const TOO_COMPLEX = "input too complex for the egress check";
const NETWORK_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);
const URL_START = /^[a-z][a-z0-9+.-]{0,31}:\/\//i;
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
  const allowed = allow.some((entry) =>
    entry.startsWith("*.") ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : host === entry,
  );
  return allowed ? { ok: true, host } : { ok: false, why: `web host not allowed: ${host.slice(0, 200)}` };
}

function push(out: string[], url: string): void {
  if (out.length >= MAX_URLS) throw new EgressInputTooComplex("too many URLs");
  out.push(url);
}

/** A string that is one URL is judged whole; free text is scanned for URL substrings (M5R22). */
export function urlsInString(value: string, out: string[]): void {
  const text = value.trim();
  if (URL_START.test(text) && !text.includes(" ")) return push(out, text);
  if (!text.includes("://")) return;
  for (const match of text.matchAll(URL_IN_TEXT)) {
    let end = match[0].length;
    while (end > 0 && TRAILING.has(match[0][end - 1] ?? "")) end--;
    push(out, match[0].slice(0, end));
  }
}

function gitSubcommand(rest: readonly string[]): string | undefined {
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i] ?? "";
    if (word === "-C" || word === "-c") i++;
    else if (!word.startsWith("-")) return word;
  }
  return undefined;
}

/** A command that reaches another host by itself (M5R118). */
export function reachesNetwork(argv: readonly string[]): boolean {
  const [command = "", ...rest] = argv;
  if (ALWAYS_NETWORK.has(command)) return true;
  if (command === "git") return GIT_NETWORK.has(gitSubcommand(rest) ?? "");
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
  for (const item of Array.isArray(value) ? value : Object.values(value))
    walk(item, depth + 1, counters, out, inJson);
}

function urlsOfCommand(command: string, out: string[]): string | null {
  let uncheckable: string | null = null;
  for (const segment of readCommands(command)) {
    const before = out.length;
    for (const word of segment.words) urlsInString(word, out);
    const argv = argvOf(segment);
    if (uncheckable === null && out.length === before && reachesNetwork(argv)) uncheckable = argv[0] ?? null;
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
    // A built-in shell call is its command alone; every other tool is walked whole, a `command` field included.
    if (!call.exec) walk(event.input, 0, { strings: 0, nodes: 0 }, out, false);
  }
  return { urls: [...new Set(out)], uncheckable };
}

const block = (reason: string): StageResult => ({
  outcome: "block",
  reason,
  modelReason: EGRESS_MODEL_REASON,
});

/** Stage 02 (M5R21 to M5R23, M5R118): reasons name a host or a client, never the input. */
export function egressStage(call: CallFacts): StageResult {
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
