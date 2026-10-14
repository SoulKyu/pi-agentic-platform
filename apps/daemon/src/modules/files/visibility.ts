import type { GitRunner } from "../../kernel/git/runner.ts";
import type { Logger } from "../../kernel/logger.ts";

export type Hidden = "ignored" | "excluded";

/** Never listed, whatever a repository says (pi-web's rule too). */
export const ALWAYS_HIDDEN: ReadonlySet<string> = new Set([".git", ".DS_Store"]);

/** Where git has no view: conventionally generated names (M8R24, M8R27's walk skips them too). */
export const EXCLUDED_NAMES: ReadonlySet<string> = new Set([
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

/** git answers within this, or the fixed list stands in (M8R24). */
export const GIT_LISTING_MS = 5000;
/** Ignored names asked about in the `ls-files` call; the rest stay hidden. */
export const TRACKED_LOOKUPS = 200;

const NUL = "\0";

/**
 * Which of `names` (entries of the folder `rel` under the repository root `root`) git ignores, minus those holding a
 * tracked path. Names go to git as `./rel/name`: a name like `:(glob)x` cannot be pathspec magic, and one starting with `-`
 * cannot be an option. Null when git has no view of the folder (not a work tree, it failed or ran out of time, or the
 * folder is itself ignored with nothing tracked below it): the caller applies the fixed list.
 */
async function ignoredNames(
  git: GitRunner,
  root: string,
  rel: string,
  names: readonly string[],
  logger: Logger,
): Promise<Set<string> | null> {
  const prefix = rel === "" ? "./" : `./${rel}/`;
  const asked = new Set(names);
  try {
    const input = [...(rel === "" ? [] : [`./${rel}`]), ...names.map((name) => `${prefix}${name}`)]
      .map((path) => `${path}${NUL}`)
      .join("");
    // Exit code 1: nothing is ignored, an answer. No --index: a scan of the whole index per name.
    const checked = await git.run(root, ["check-ignore", "-z", "--stdin", "--no-index"], {
      input: Buffer.from(input),
      okCodes: [0, 1],
      timeoutMs: GIT_LISTING_MS,
    });
    let folderIgnored = false;
    const matched: string[] = [];
    for (const record of checked.stdout.toString("utf8").split(NUL)) {
      if (rel !== "" && record === `./${rel}`) folderIgnored = true;
      else if (record.startsWith(prefix) && asked.has(record.slice(prefix.length)))
        matched.push(record.slice(prefix.length));
    }
    if (matched.length === 0) return folderIgnored ? null : new Set();
    const tracked = await trackedAmong(git, root, rel, matched.slice(0, TRACKED_LOOKUPS));
    if (folderIgnored && tracked.size === 0) return null;
    return new Set(matched.filter((name) => !tracked.has(name)));
  } catch (error) {
    // git already logged why (the runner's warning); a listing without it is still a listing.
    logger.debug("files_visibility_fallback", {
      code: (error as { kind?: unknown } | null)?.kind ?? "unknown",
    });
    return null;
  }
}

/** The names that hold a tracked path: the name itself or anything below it. */
async function trackedAmong(
  git: GitRunner,
  root: string,
  rel: string,
  names: readonly string[],
): Promise<Set<string>> {
  const prefix = rel === "" ? "" : `${rel}/`;
  const listed = await git.run(
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

/** Why an entry is left out of the default listing, or null when it is shown. */
export async function hiddenReasons(
  git: GitRunner,
  root: string,
  rel: string,
  names: readonly string[],
  logger: Logger,
): Promise<(name: string) => Hidden | null> {
  const candidates = names.filter((name) => !ALWAYS_HIDDEN.has(name));
  const ignored = candidates.length > 0 ? await ignoredNames(git, root, rel, candidates, logger) : null;
  return (name) => {
    if (ignored === null) return EXCLUDED_NAMES.has(name) ? "excluded" : null;
    return ignored.has(name) ? "ignored" : null;
  };
}
