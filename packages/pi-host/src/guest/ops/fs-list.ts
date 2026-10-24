import { lstatSync, readdirSync, realpathSync, statSync, type Stats } from "node:fs";
import { compareCodePoints, FILE_LIMITS, type FileEntry, PAGE_BYTES, sizeOf } from "@pap/contracts";
import { runGit } from "./git-run.ts";
import { inGit, type OpEnv, segmentsOf, withFolder } from "./paths.ts";

/** Entries read from one folder at most; a larger folder is cut and says so. */
export const LIST_SCAN_MAX = 20_000;
const GIT_LISTING_MS = 5000;
const TRACKED_LOOKUPS = 200;
const NUL = "\0";
/** Never listed, whatever a repository says: the host's rule (`ALWAYS_HIDDEN`). */
const NEVER_LISTED: ReadonlySet<string> = new Set([".git", ".DS_Store"]);
/** Where git has no view: conventionally generated names. */
const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".turbo",
  ".parcel-cache",
]);
const TEMP_NAME = /^\.pap-[0-9a-f]{12}\.tmp$/;
const ENVELOPE_BYTES = sizeOf({ entries: [], truncated: true });

type Described = Omit<FileEntry, "hidden">;

const within = (root: string, target: string): boolean => target === root || target.startsWith(`${root}/`);

function describe(
  name: string,
  st: Stats,
  at: string,
  projectReal: string,
  protectedName: boolean,
): Described {
  const base = {
    name,
    size: st.isFile() ? st.size : null,
    mtimeMs: Math.max(0, st.mtimeMs),
    protected: protectedName,
    link: null,
    linkDir: false,
  } as const;
  if (st.isDirectory()) return { ...base, kind: "dir" };
  if (st.isFile()) return { ...base, kind: "file" };
  if (!st.isSymbolicLink()) return { ...base, kind: "other" };
  try {
    const target = realpathSync(at);
    return {
      ...base,
      kind: "link",
      link: within(projectReal, target) ? "inside" : "outside",
      linkDir: statSync(target, { throwIfNoEntry: false })?.isDirectory() ?? false,
    };
  } catch {
    return { ...base, kind: "link", link: "broken" };
  }
}

/** The names that hold a tracked path: the name itself or anything below it. */
async function trackedAmong(root: string, rel: string, names: readonly string[]): Promise<Set<string>> {
  const prefix = rel === "" ? "" : `${rel}/`;
  const listed = await runGit(
    root,
    ["ls-files", "-z", "--cached", "--", ...names.map((name) => `./${prefix}${name}`)],
    { timeoutMs: GIT_LISTING_MS },
  );
  const tracked = new Set<string>();
  for (const record of listed.stdout.toString("utf8").split(NUL)) {
    if (record.startsWith(prefix)) tracked.add(record.slice(prefix.length).split("/", 1)[0] ?? "");
  }
  return tracked;
}

/**
 * Which of `names` (entries of the folder `rel`) git ignores, minus those holding a tracked path. Names go to git as
 * `./rel/name`, so none can be pathspec magic or an option. Null when git has no view (no repository, a failure, a
 * timeout, or the folder is itself ignored with nothing tracked below): the fixed list stands in.
 */
async function ignoredNames(
  root: string,
  rel: string,
  names: readonly string[],
): Promise<Set<string> | null> {
  const prefix = rel === "" ? "./" : `./${rel}/`;
  try {
    const input = [...(rel === "" ? [] : [`./${rel}`]), ...names.map((name) => `${prefix}${name}`)]
      .map((path) => `${path}${NUL}`)
      .join("");
    const checked = await runGit(root, ["check-ignore", "-z", "--stdin", "--no-index"], {
      input: Buffer.from(input),
      okCodes: [0, 1],
      timeoutMs: GIT_LISTING_MS,
    });
    const asked = new Set(names);
    let folderIgnored = false;
    const matched: string[] = [];
    for (const record of checked.stdout.toString("utf8").split(NUL)) {
      if (rel !== "" && record === `./${rel}`) folderIgnored = true;
      else if (record.startsWith(prefix) && asked.has(record.slice(prefix.length)))
        matched.push(record.slice(prefix.length));
    }
    if (matched.length === 0) return folderIgnored ? null : new Set();
    const tracked = await trackedAmong(root, rel, matched.slice(0, TRACKED_LOOKUPS));
    if (folderIgnored && tracked.size === 0) return null;
    return new Set(matched.filter((name) => !tracked.has(name)));
  } catch {
    return null;
  }
}

const isFolder = (entry: FileEntry): boolean =>
  entry.kind === "dir" || (entry.kind === "link" && entry.linkDir);

/** Folders first, then the rest, each by lower-cased name and then by code point. */
function byFoldersThenName(a: FileEntry, b: FileEntry): number {
  return (
    Number(isFolder(b)) - Number(isFolder(a)) ||
    compareCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareCodePoints(a.name, b.name)
  );
}

function fitPage(entries: FileEntry[]): { kept: FileEntry[]; cut: boolean } {
  let used = ENVELOPE_BYTES;
  for (let i = 0; i < entries.length; i++) {
    used += sizeOf(entries[i]) + 1;
    if (used > PAGE_BYTES) return { kept: entries.slice(0, i), cut: true };
  }
  return { kept: entries, cut: false };
}

/**
 * `fs.list`: the folder's entries as the host's `files.list` shows them. `.git` is not listed, as on the host (a path inside it can still be listed and read, `protected`); a name git ignores is hidden unless `showIgnored`.
 */
export async function fsList(
  env: OpEnv,
  args: { readonly path: string; readonly showIgnored: boolean },
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const segments = segmentsOf(env.project, args.path);
  const projectReal = realpathSync(env.project);
  const insideGit = inGit(segments);
  const { described, cut } = withFolder(env.project, segments, (fd) => {
    const folder = `/proc/self/fd/${fd}`;
    const all = readdirSync(folder);
    const names = all
      .slice(0, LIST_SCAN_MAX)
      .filter((name) => !NEVER_LISTED.has(name) && !TEMP_NAME.test(name));
    const out: Described[] = [];
    for (const name of names) {
      try {
        const at = `${folder}/${name}`;
        out.push(describe(name, lstatSync(at), at, projectReal, insideGit));
      } catch {
        // gone since the read: not listed
      }
    }
    return { described: out, cut: all.length > LIST_SCAN_MAX };
  });
  const candidates = described.map((entry) => entry.name);
  const ignored =
    insideGit || candidates.length === 0
      ? null
      : await ignoredNames(env.project, segments.join("/"), candidates);
  const hiddenOf = (name: string): FileEntry["hidden"] => {
    if (ignored === null) return EXCLUDED_NAMES.has(name) ? "excluded" : null;
    return ignored.has(name) ? "ignored" : null;
  };
  const visible = described
    .map((entry): FileEntry => ({ ...entry, hidden: hiddenOf(entry.name) }))
    .filter((entry) => args.showIgnored || entry.hidden === null)
    .sort(byFoldersThenName);
  const capped = visible.slice(0, FILE_LIMITS.listEntries);
  const { kept, cut: pageCut } = fitPage(capped);
  return { entries: kept, truncated: cut || pageCut || visible.length > capped.length };
}
