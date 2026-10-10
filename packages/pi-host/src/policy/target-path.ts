import { lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_LINK_HOPS = 40;
const UNICODE_SPACES = /\p{Zs}/gu;

// Pi rewrites a tool path before it opens the file (`~`, a leading `@`, file: URLs, unicode spaces).
// The policy must judge where the write really lands, so it follows the same rewrites.
function asPiResolves(path: string): string {
  const unprefixed = path.replace(UNICODE_SPACES, " ").replace(/^@/, "");
  if (unprefixed === "~") return homedir();
  if (unprefixed.startsWith("~/")) return join(homedir(), unprefixed.slice(2));
  if (unprefixed.startsWith("file://")) return fileURLToPath(unprefixed);
  return unprefixed;
}

const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

async function lstatIfPresent(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

// realpath of the nearest existing ancestor plus the segments that do not exist yet, following dangling symlinks.
async function realTarget(path: string, hops = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  if ((await lstatIfPresent(path))?.isSymbolicLink()) {
    if (hops >= MAX_LINK_HOPS) throw new Error("too many symbolic links");
    const directory = await realpath(dirname(path));
    return realTarget(resolve(directory, await readlink(path)), hops + 1);
  }
  const parent = dirname(path);
  if (parent === path) throw new Error("no existing ancestor");
  return join(await realTarget(parent, hops), basename(path));
}

function within(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

const PROTECTED_SEGMENTS: ReadonlySet<string> = new Set([".git", ".pi", ".agents", ".husky", ".vscode"]);
const PROTECTED_BASENAMES: ReadonlySet<string> = new Set([".envrc"]);

// Files that run later, outside any approval: git hooks and config (core.fsmonitor), Pi settings
// (shellCommandPrefix) and extensions, agent skills, hook managers, editor tasks, direnv.
function hasProtectedName(relativePath: string): boolean {
  const segments = relativePath
    .split(sep)
    .filter(Boolean)
    .map((segment) => segment.normalize("NFC").toLowerCase());
  return segments.some((s) => PROTECTED_SEGMENTS.has(s)) || PROTECTED_BASENAMES.has(segments.at(-1) ?? "");
}

export type ReviewReason =
  "outside the session directory" | "protected path" | "session directory too broad for automatic edits";

export interface EditReview {
  readonly why: ReviewReason;
  readonly target?: string;
}

export type EditCheck = { readonly auto: true } | { readonly auto: false; readonly review: EditReview };

/**
 * Whether an edit may run without asking. It may when the file it would write, symlinks followed, is inside
 * `cwd`, is not a protected path, and `cwd` is not the home directory, a parent of it, or a parent of the
 * agent directory. Both the literal reading of the path and Pi's rewritten reading are judged. Anything that
 * is not a plain, non-empty path string asks. Otherwise the review says why, and where the write lands.
 */
export async function checkEditTarget(path: unknown, cwd: string, agentDir: string): Promise<EditCheck> {
  if (typeof path !== "string" || path === "" || path.includes("\0")) {
    return { auto: false, review: { why: "outside the session directory" } };
  }
  const home = homedir();
  if (!home) throw new Error("the home directory is unknown");
  const root = await realpath(cwd);
  const lexicalRoot = resolve(cwd);
  const agent = await realTarget(resolve(agentDir));
  const tooBroad = within(root, await realTarget(resolve(home))) || within(root, agent);
  let target: string | undefined;
  let outside: string | undefined;
  let protectedPath: string | undefined;
  for (const spelling of new Set([path, asPiResolves(path)])) {
    const lexical = resolve(cwd, spelling);
    const real = await realTarget(lexical);
    target ??= real;
    if (!within(root, real)) outside ??= real;
    const namedProtected =
      (within(root, real) && hasProtectedName(relative(root, real))) ||
      (within(lexicalRoot, lexical) && hasProtectedName(relative(lexicalRoot, lexical)));
    if (within(agent, real) || namedProtected) protectedPath ??= real;
  }
  if (protectedPath) return { auto: false, review: { why: "protected path", target: protectedPath } };
  if (outside) return { auto: false, review: { why: "outside the session directory", target: outside } };
  if (tooBroad) {
    return { auto: false, review: { why: "session directory too broad for automatic edits", target } };
  }
  return { auto: true };
}
