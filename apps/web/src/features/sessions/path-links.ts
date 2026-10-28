import type { LinkedSpan } from "@pap/ui";
import type { PathScope } from "../../stores/reply-ports.ts";

/** What a text node is scanned for (UX1-R14): the first units only, and a handful of links per node. */
const SCAN_UNITS = 20_000;
const MAX_SPANS = 64;
const MAX_TOKEN = 512;
const TRAILING = ".,;:!?)]";
const MAX_TRAILING = 4;

const TOKEN = /[^\s()[\]{}<>"'`,;|]+/gu;
/** `:` is outside the path class, so the optional `:line` cannot overlap it: one linear pass. */
const PATH = /^([\p{L}\p{N}._@+/-]+)(?::([1-9]\d{0,6})(?::[1-9]\d{0,4})?)?$/u;

const KNOWN_EXTENSIONS = new Set(
  (
    "ts tsx js jsx mjs cjs mts cts json jsonc yaml yml toml ini cfg conf env md mdx markdown txt rst html htm css " +
    "scss sass less svg png jpg jpeg gif webp ico py pyi rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh " +
    "fish sql lock xml csv tsv vue svelte astro proto graphql gradle tf tfvars log diff patch ipynb pdf"
  ).split(" "),
);
const KNOWN_NAMES = new Set(["Dockerfile", "Makefile"]);

const under = (path: string, root: string): boolean => {
  const base = root.endsWith("/") ? root.slice(0, -1) : root;
  return path === base || path.startsWith(`${base}/`);
};

function hasKnownName(name: string): boolean {
  if (KNOWN_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 1) return false; // no extension, or nothing before it (`.env`)
  // `Node.js`, `Next.js`: a product name, not a file.
  if (/^\p{Lu}/u.test(name) && name.slice(dot + 1) === "js") return false;
  return KNOWN_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

function resolve(raw: string, scope: PathScope): string | null {
  if (raw.endsWith("/")) return null; // folders stay text
  const absolute = raw.startsWith("/");
  const segments = (absolute ? raw.slice(1) : raw).split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return null;
  const first = segments[0] ?? "";
  if (!absolute) {
    // `and/or` and `example.com/a` are prose and hosts: a relative path names a file with a known extension.
    if (!hasKnownName(segments.at(-1) ?? "")) return null;
    if (segments.length > 1 && first.includes(".") && !first.startsWith(".")) return null;
  }
  const full = absolute ? raw : `${scope.base.replace(/\/$/, "")}/${raw}`;
  if (!scope.roots.some((root) => under(full, root))) return null;
  let target = full;
  if (scope.agentId !== null) {
    if (!full.startsWith("/agent/")) return null;
    target = `/agents/${scope.agentId}/${full.slice("/agent/".length)}`;
  }
  return under(target, scope.filesRoot) ? target : null;
}

function classify(token: string, scope: PathScope): { path: string; line: number | null } | null {
  if (token.length > MAX_TOKEN) return null;
  const match = PATH.exec(token);
  const raw = match?.[1];
  if (raw === undefined) return null;
  const path = resolve(raw, scope);
  return path === null ? null : { path, line: match?.[2] === undefined ? null : Number(match[2]) };
}

function trimTrailing(token: string): string {
  let end = token.length;
  while (token.length - end < MAX_TRAILING && end > 0 && TRAILING.includes(token.charAt(end - 1))) end -= 1;
  return token.slice(0, end);
}

/**
 * The paths a text names, in order, for the session's scope. Pure: no request is made, a file's existence is the
 * viewer's to say. `whole`: the text must be exactly one path (an inline code span).
 */
export function findPaths(text: string, scope: PathScope, whole = false): LinkedSpan[] {
  if (whole) {
    const hit = classify(text, scope);
    return hit === null ? [] : [{ start: 0, end: text.length, text, ...hit }];
  }
  const cut = text.length > SCAN_UNITS;
  const spans: LinkedSpan[] = [];
  for (const match of (cut ? text.slice(0, SCAN_UNITS) : text).matchAll(TOKEN)) {
    const start = match.index;
    // A token that runs into the scan edge may be a longer path cut short: it is not read.
    if (cut && start + match[0].length === SCAN_UNITS) continue;
    const token = trimTrailing(match[0]);
    const hit = classify(token, scope);
    if (hit === null) continue;
    spans.push({ start, end: start + token.length, text: token, ...hit });
    if (spans.length === MAX_SPANS) break;
  }
  return spans;
}
