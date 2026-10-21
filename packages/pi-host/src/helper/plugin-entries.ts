import { MASK, maskUrl } from "./mask.ts";
import { HelperOpError } from "./ops.ts";
import { pluginSource } from "./plugin-source.ts";

/** One entry of `settings.json` `packages`: a source, or an object Pi filters resources with (M7R114). */
export type PackageEntry = string | { source: string; [key: string]: unknown };
export const RESOURCE_LISTS = ["extensions", "skills", "prompts", "themes"] as const;

export const sourceOf = (entry: PackageEntry): string => (typeof entry === "string" ? entry : entry.source);

/** Disabling writes these four empty lists on the entry (pi-web); nothing else makes a package "off". */
export function disabledEntry(source: string): PackageEntry {
  return { source, extensions: [], skills: [], prompts: [], themes: [] };
}

export interface EntryState {
  readonly enabled: boolean;
  /** Anything but a bare source or the four-empty-lists marker: a filter the owner wrote by hand. */
  readonly filtered: boolean;
}

export function stateOf(entry: PackageEntry): EntryState {
  if (typeof entry === "string") return { enabled: true, filtered: false };
  const keys = Object.keys(entry).filter((key) => key !== "source");
  const marker =
    keys.length === RESOURCE_LISTS.length &&
    RESOURCE_LISTS.every((key) => Array.isArray(entry[key]) && entry[key].length === 0);
  if (marker) return { enabled: false, filtered: false };
  return { enabled: true, filtered: keys.length > 0 };
}

/** Pi's resolution of a local entry is its business; these schemes and forms are the ones npm, git or a fetch would run. */
const REMOTE = /^(?:npm:|git:|github:|git@|[a-z][a-z0-9+.-]*:\/\/)/i;
export const isRemote = (source: string): boolean => REMOTE.test(source);

const URL_FORM = /^[a-z][a-z0-9+.-]*:\/\//i;
const USERINFO = /[^/@:\s]+:[^/@\s]+@/g;
/** `npm:<name>@<version>`: the scheme's colon and the version's `@` are not a `user:secret@` (an npm spec has no other colon). */
const NPM_SPEC = /^npm:[^:\s]+$/;

/** A source as it is shown: a URL through `maskUrl`, `npm:` and `git:` forms (which are not URLs) with any `user:secret@` hidden. */
export const maskSource = (source: string): string =>
  URL_FORM.test(source)
    ? maskUrl(source)
    : NPM_SPEC.test(source)
      ? source
      : source.replace(USERINFO, `${MASK}@`);

/**
 * A configured source Pi may be handed to install, remove or update (M7R115): a remote one only if it passes the same
 * validation as a new install. A local entry is never run by Pi's package manager here, so it needs no check. A
 * hand-written `npm:--registry=...` is neither: it is shown, and dropped from settings by `remove`, and nothing else.
 */
export function safeForPi(source: string, home: string): boolean {
  return isRemote(source) ? pluginSource(source, home) !== null : !source.startsWith("-");
}

/**
 * The configured entry a request names: its source as stored, as listed (masked), or as the absolute path it was installed
 * from. -1 when none. Two entries that match (two that mask alike) are `conflict`: the first is never acted on alone (MC55).
 */
export function findEntry(
  entries: readonly PackageEntry[],
  requested: string,
  resolveLocal: (source: string) => string,
): number {
  const found: number[] = [];
  entries.forEach((entry, index) => {
    const source = sourceOf(entry);
    if (
      source === requested ||
      maskSource(source) === requested ||
      (!isRemote(source) && resolveLocal(source) === requested)
    )
      found.push(index);
  });
  if (found.length > 1) throw new HelperOpError("conflict", "source");
  return found[0] ?? -1;
}
