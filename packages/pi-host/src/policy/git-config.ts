/**
 * A reader for git's config files, written to git's own grammar (`config.c`, `git_parse_source`), for one question:
 * does a repository's own config name a program that `git status`, `diff`, `log` or another read-only git command may
 * run (owner decision m3, ADR 0024)? Anything git would refuse, and anything this reader is unsure of, reads as null:
 * the caller then asks.
 */

import { LFS_ENTRIES } from "@pap/contracts/pi-host";

export interface GitConfigEntry {
  /** The first part of the name, lower case (`diff` in `diff.<driver>.textconv`). */
  readonly section: string;
  /** The middle part as git keeps it (`[a "B"]` gives `B`, `[a.B]` gives `b`), or null. */
  readonly subsection: string | null;
  /** The last part, lower case. */
  readonly key: string;
  /** null for a bare key, which git reads as `true`. */
  readonly value: string | null;
}

export const MAX_GIT_CONFIG_ENTRIES = 4096;
/** git's `isspace` once `\r\n` is a line break: `\n` ends a line, these are blanks. */
const BLANK: ReadonlySet<string> = new Set([" ", "\t", "\r"]);
const ALPHA = /^[A-Za-z]$/;
const KEY_CHAR = /^[A-Za-z0-9-]$/;
const ESCAPES: Readonly<Record<string, string>> = { t: "\t", b: "\b", n: "\n", "\\": "\\", '"': '"' };

const lineEnd = (text: string, at: number): number => {
  const end = text.indexOf("\n", at);
  return end === -1 ? text.length : end;
};

/** `[section]`, `[section.sub]` or `[section "sub"]`, from just after the `[`: the name stem, or null. */
function readHeader(text: string, start: number): { readonly stem: string; readonly next: number } | null {
  let at = start;
  let stem = "";
  for (;;) {
    const c = text[at++];
    if (c === undefined || c === "\n") return null;
    if (c === "]") return stem === "" ? null : { stem, next: at };
    if (BLANK.has(c)) break;
    if (!KEY_CHAR.test(c) && c !== ".") return null;
    stem += c.toLowerCase();
  }
  if (stem === "") return null;
  while (BLANK.has(text[at] ?? "")) at++;
  if (text[at++] !== '"') return null;
  let sub = "";
  for (;;) {
    let c = text[at++];
    if (c === undefined || c === "\n") return null;
    if (c === '"') break;
    if (c === "\\") {
      c = text[at++];
      if (c === undefined || c === "\n") return null;
    }
    sub += c;
  }
  if (text[at++] !== "]") return null;
  return { stem: `${stem}.${sub}`, next: at };
}

/** git's `parse_value`, from just after the `=`: quotes, the five escapes, `\` before a line break, comments, trimming. */
function readValue(text: string, start: number): { readonly value: string; readonly next: number } | null {
  let at = start;
  let value = "";
  let quote = false;
  let comment = false;
  let trim = 0;
  for (;;) {
    const c = at < text.length ? (text[at++] as string) : "\n";
    if (c === "\n") {
      if (quote) return null;
      return { value: trim > 0 ? value.slice(0, trim) : value, next: at };
    }
    if (comment) continue;
    if (BLANK.has(c) && !quote) {
      if (trim === 0) trim = value.length;
      if (value.length > 0) value += c;
      continue;
    }
    if (!quote && (c === ";" || c === "#")) {
      comment = true;
      continue;
    }
    trim = 0;
    if (c === "\\") {
      const next = at < text.length ? (text[at++] as string) : "\n";
      if (next === "\n") continue;
      const escaped = ESCAPES[next];
      if (escaped === undefined) return null;
      value += escaped;
      continue;
    }
    if (c === '"') {
      quote = !quote;
      continue;
    }
    value += c;
  }
}

function entryOf(stem: string, key: string, value: string | null): GitConfigEntry {
  const dot = stem.indexOf(".");
  return dot === -1
    ? { section: stem, subsection: null, key, value }
    : { section: stem.slice(0, dot), subsection: stem.slice(dot + 1), key, value };
}

/** Every entry of a config file in order, or null when git would refuse the file or this reader is unsure. */
export function parseGitConfig(raw: string): GitConfigEntry[] | null {
  const text = (raw.startsWith("\uFEFF") ? raw.slice(1) : raw).replaceAll("\r\n", "\n");
  const entries: GitConfigEntry[] = [];
  let stem: string | null = null;
  let at = 0;
  while (at < text.length) {
    const c = text[at] as string;
    if (c === "\n" || BLANK.has(c)) {
      at++;
      continue;
    }
    if (c === "#" || c === ";") {
      at = lineEnd(text, at);
      continue;
    }
    if (c === "[") {
      const header = readHeader(text, at + 1);
      if (header === null) return null;
      stem = header.stem;
      at = header.next;
      continue;
    }
    // A key before any section, or a line git cannot read: git stops with "bad config line".
    if (!ALPHA.test(c) || stem === null) return null;
    let end = at + 1;
    while (end < text.length && KEY_CHAR.test(text[end] as string)) end++;
    const key = text.slice(at, end).toLowerCase();
    at = end;
    while (text[at] === " " || text[at] === "\t") at++;
    let value: string | null = null;
    if (at < text.length && text[at] !== "\n") {
      if (text[at] !== "=") return null;
      const read = readValue(text, at + 1);
      if (read === null) return null;
      value = read.value;
      at = read.next;
    }
    if (entries.length >= MAX_GIT_CONFIG_ENTRIES) return null;
    entries.push(entryOf(stem, key, value));
  }
  return entries;
}

/**
 * Keys whose value git runs as a program, by section (owner m3: `core.fsmonitor`, `diff.external`, `diff.*.command`,
 * `*.textconv`, `filter.*.{clean,smudge,process}`, `core.pager`, `core.editor`, `core.sshCommand`, `gpg.program`,
 * `credential.helper`), each in every spelling git reads (`credential.<url>.helper`, `gpg.<format>.program`), plus
 * `pager.<command>`, `core.askPass`, `sequence.editor` and `core.hooksPath` (M7 ruling MC8: a repository-local hooks
 * folder is a place for `post-index-change`), which run a program the same way. The subsection is never
 * looked at: `[core "x"] pager` asks too. Two relaxations (M7 ruling MC4): `core.fsmonitor` with a boolean value uses
 * git's own daemon, and the exact standard git-lfs filter entries run the git-lfs binary.
 */
const RUNS_PROGRAM: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  [
    "core",
    new Set([
      "fsmonitor",
      "pager",
      "editor",
      "sshcommand",
      "askpass",
      "hookspath",
      "gitproxy",
      "alternaterefscommand",
    ]),
  ],
  // M7 ruling MC13: a partial clone's lazy fetch, a transport and a hook run a program on read commands.
  ["extensions", new Set(["partialclone"])],
  ["remote", new Set(["promisor", "uploadpack", "receivepack"])],
  ["protocol", new Set(["allow"])],
  ["uploadpack", new Set(["packobjectshook"])],
  ["log", new Set(["showsignature"])],
  ["diff", new Set(["external", "command"])],
  ["filter", new Set(["clean", "smudge", "process"])],
  ["gpg", new Set(["program"])],
  ["credential", new Set(["helper"])],
  ["sequence", new Set(["editor"])],
]);
/** `pager.<command>` takes a boolean (pager on or off) or a program. */
const GIT_BOOLEAN = /^(?:|true|false|yes|no|on|off|[+-]?\d+)$/i;
/** The spellings `core.fsmonitor` may take as a boolean: anything else is a hook program. */
const FSMONITOR_BOOLEAN = /^(?:true|false|yes|no|on|off|1|0)$/i;

export function runsProgram(entry: GitConfigEntry): boolean {
  if (entry.key === "textconv") return true;
  if (entry.section === "pager") return entry.value !== null && !GIT_BOOLEAN.test(entry.value);
  if (entry.section === "core" && entry.key === "fsmonitor")
    return entry.value !== null && !FSMONITOR_BOOLEAN.test(entry.value);
  if (entry.section === "filter" && entry.subsection === "lfs" && entry.value !== null) {
    if (LFS_ENTRIES.get(entry.key) === entry.value) return false;
  }
  return RUNS_PROGRAM.get(entry.section)?.has(entry.key) ?? false;
}

/** The value of an `include.path` or `includeIf.<condition>.path` (every condition counts), null when bare, else undefined. */
export function includeOf(entry: GitConfigEntry): string | null | undefined {
  if (entry.key !== "path" || (entry.section !== "include" && entry.section !== "includeif"))
    return undefined;
  return entry.value;
}

/**
 * `extensions.objectFormat` other than sha1 (or bare, or `compatObjectFormat`): the index then holds longer object
 * names and the guard's index reader would walk it differently from git, so the command asks (M7 ruling MC10).
 */
export function otherObjectFormat(entry: GitConfigEntry): boolean {
  if (entry.section !== "extensions") return false;
  if (entry.key === "compatobjectformat") return true;
  return entry.key === "objectformat" && entry.value?.toLowerCase() !== "sha1";
}
