import { cp, lstat, mkdir, readdir, readlink, realpath, rm, symlink, unlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { type BoundaryConfig, judgePath, type Scope, within } from "../../kernel/fs/boundary.ts";
import type { DenySet } from "../../kernel/fs/deny-set.ts";
import type { GitRunner } from "../../kernel/git/runner.ts";

/** Everything one lane copies from the owner's checkout, together (M9R24). */
export const COPY_CAP_BYTES = 256 * 1024 * 1024;
/** And of files: a copy past this fails the lane's preparation (it is undone), where the byte cap only skips the rest. */
export const COPY_MAX_FILES = 100_000;

export class CopyLimitError extends Error {
  constructor() {
    super("copy file limit reached");
    this.name = "CopyLimitError";
  }
}

export interface CopyLinkInput {
  /** The owner's main checkout. */
  readonly root: string;
  /** The lane's folder, already created by `worktree add`. */
  readonly worktree: string;
  /** The git dir pap stored for the lane (MC2): the lane's `.git` file is never read. */
  readonly gitDir: string;
  readonly copy: readonly string[];
  readonly link: readonly string[];
  readonly git: GitRunner;
  /** M8's path judge and private-inode set: a lane never receives what the explorer would refuse (M9R24, review I1). */
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  /** The folders the deny set walks (`denySourcesOf(boundary).folders`): `~/.ssh`, `~/.config/gh`, `$PAP_HOME`... */
  readonly denyFolders: readonly string[];
  /** One line of the setup log. */
  log(line: string): void;
  /** Throws when the lane's filesystem is too full for a copy (M9R117). */
  diskFloor(path: string): Promise<void> | void;
  /** The caller's deadline: an aborted signal stops the copy and the call rejects with the signal's reason. */
  readonly signal?: AbortSignal;
  /** Tests only. */
  readonly copyCapBytes?: number;
  readonly copyMaxFiles?: number;
}

type Reason =
  "missing" | "outside" | "denied" | "not_ignored" | "exists" | "disk" | "cap" | "failed" | "symlink" | "git";
const NUL = "\0";
const DIR_MODE = 0o755;
const REFUSALS: ReadonlySet<string> = new Set<Reason>(["missing", "outside", "denied"]);
/** A linked folder is read this far for private files (its first level only). */
const LINK_PROBE_ENTRIES = 10_000;

/** A name as one line of text: a newline or control character in a file name cannot fake a second log line. */
const quoted = (name: string): string => JSON.stringify(name);

const underGit = (rel: string): boolean => rel.split(sep).some((segment) => segment.toLowerCase() === ".git");

/** Which of `entries` (relative paths) git ignores in `cwd`; names go as `./name`, on stdin, so they are never options or magic. */
async function ignoredIn(
  git: GitRunner,
  cwd: string,
  entries: readonly string[],
  gitDir?: string,
): Promise<Set<string>> {
  if (entries.length === 0) return new Set();
  const { stdout } = await git.run(cwd, ["check-ignore", "-z", "--stdin", "--no-index"], {
    input: Buffer.from(entries.map((entry) => `./${entry}${NUL}`).join("")),
    okCodes: [0, 1],
    ...(gitDir === undefined ? {} : { gitDir }),
  });
  const ignored = new Set<string>();
  for (const record of stdout.toString("utf8").split(NUL))
    if (record.startsWith("./")) ignored.add(record.slice(2));
  return ignored;
}

/** The real folder `entry`'s parent leads to, created segment by segment: no segment may be a link, none may leave the lane. */
async function ensureParent(realWorktree: string, entry: string): Promise<boolean> {
  let current = realWorktree;
  for (const segment of dirname(entry) === "." ? [] : dirname(entry).split("/")) {
    const next = join(current, segment);
    let info = await lstat(next).catch(() => null);
    if (info === null) {
      await mkdir(next, { mode: DIR_MODE }).catch(() => undefined);
      info = await lstat(next).catch(() => null);
    }
    if (info === null || info.isSymbolicLink() || !info.isDirectory()) return false;
    current = next;
  }
  return (await realpath(current).catch(() => null)) === current && within(realWorktree, current);
}

/**
 * M9R24, M9-RT-05. Only ignored files are copied or linked, and only from inside the main checkout (real path, `.git`
 * excluded); the destination is built inside the lane without following a link. A symlink in a copied folder is kept only
 * when it is relative and stays inside the checkout, both as written and as it resolves. Every skip is one log line and
 * counts once. The disk floor runs before each copy; a full disk skips the entry and the lane goes on.
 */
export async function applyCopyLink(input: CopyLinkInput): Promise<{ skipped: number }> {
  const { git, log } = input;
  let skipped = 0;
  let used = 0;
  const cap = input.copyCapBytes ?? COPY_CAP_BYTES;
  const maxFiles = input.copyMaxFiles ?? COPY_MAX_FILES;
  let files = 0;
  let overFiles = false;
  input.signal?.throwIfAborted();
  const skip = (kind: "copy" | "link", entry: string, reason: Reason, hint = ""): void => {
    skipped += 1;
    log(`skipped ${kind} ${quoted(entry)}: ${reason}${hint === "" ? "" : ` (${hint})`}`);
  };
  const realRoot = await realpath(input.root);
  const realWorktree = await realpath(input.worktree);
  const denyFolders = await Promise.all(
    input.denyFolders.map((folder) => realpath(folder).catch(() => folder)),
  );
  const scope: Scope = { roots: [realRoot], config: input.boundary, caller: "session" };

  /** The entry's real source inside the owner's checkout, or why it is refused. */
  async function sourceOf(entry: string): Promise<string | Reason> {
    const real = await realpath(join(realRoot, entry)).catch(() => null);
    if (real === null) return "missing";
    const rel = relative(realRoot, real);
    if (!within(realRoot, real) || rel === "" || underGit(rel)) return "outside";
    // `$PAP_HOME`, Pi's private files: refused for every intent (M8R16), here as everywhere.
    return (await judgePath(real, scope, "read")).ok ? real : "denied";
  }

  /** A linked folder exposes everything under it: refuse one that is, holds or sits above a private place. */
  async function linkSourceOk(real: string): Promise<boolean> {
    const private_ = [...input.boundary.papHome, ...input.boundary.agentDir];
    if (private_.some((path) => within(real, path))) return false;
    // At, inside or above a denied folder: a separator-aware path comparison, no tree walk (`.config` vs `.config/gh`).
    if (denyFolders.some((folder) => within(real, folder) || within(folder, real))) return false;
    const info = await lstat(real, { bigint: true });
    if (info.isFile()) return !(await input.deny.has(info));
    const names = await readdir(real).catch(() => []);
    // Fail closed: a listing past the cap is not probed in full; a nested repository's `.git` is never linked.
    if (names.length > LINK_PROBE_ENTRIES || names.some((name) => name.toLowerCase() === ".git"))
      return false;
    for (const name of names) {
      const inner = await lstat(join(real, name), { bigint: true }).catch(() => null);
      if (inner?.isFile() && (await input.deny.has(inner))) return false;
    }
    return true;
  }

  /** A link inside a copied folder survives only if the lane's copy of it cannot reach the owner's disk. */
  async function nestedLinkOk(path: string): Promise<boolean> {
    const target = await readlink(path).catch(() => null);
    if (target === null || target.startsWith("/")) return false;
    const rel = relative(realRoot, dirname(path));
    if (!within("/v", resolve("/v", rel, target))) return false;
    const real = await realpath(path).catch(() => null);
    return (
      real !== null &&
      within(realRoot, real) &&
      relative(realRoot, real) !== "" &&
      !underGit(relative(realRoot, real))
    );
  }

  async function copyEntry(entry: string, source: string): Promise<void> {
    try {
      await input.diskFloor(input.worktree);
    } catch {
      return skip("copy", entry, "disk");
    }
    const target = join(realWorktree, entry);
    let capped = false;
    try {
      await cp(source, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
        verbatimSymlinks: true,
        filter: async (from) => {
          input.signal?.throwIfAborted();
          if (overFiles) return false;
          if (underGit(relative(realRoot, from))) {
            skip("copy", relative(realRoot, from), "git");
            return false;
          }
          const info = await lstat(from, { bigint: true });
          if (info.isSymbolicLink()) {
            if (await nestedLinkOk(from)) return true;
            skip("copy", relative(realRoot, from), "symlink", "leaves the checkout");
            return false;
          }
          if (info.isFile()) {
            // A hard link to a private file is the same inode under another name (M8R103).
            if (await input.deny.has(info)) {
              skip("copy", relative(realRoot, from), "denied");
              return false;
            }
            files += 1;
            if (files > maxFiles) {
              overFiles = true;
              return false;
            }
            const size = Number(info.size);
            if (used + size > cap) {
              capped = true;
              return false;
            }
            used += size;
          }
          return true;
        },
      });
    } catch {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      return skip("copy", entry, "failed");
    }
    if (capped) skip("copy", entry, "cap", "256 MiB per lane, the rest was left out");
    copied.push(entry);
  }

  async function linkEntry(entry: string, source: string): Promise<void> {
    if (!(await linkSourceOk(source))) return skip("link", entry, "denied");
    const target = join(realWorktree, entry);
    await symlink(source, target);
    // `node_modules/` (trailing slash) matches a folder, not a link to one: a linked folder must be ignored as itself.
    const kept = await ignoredIn(git, input.worktree, [entry], input.gitDir).catch(() => new Set<string>());
    if (kept.has(entry)) return;
    await unlink(target);
    const escaped = quoted(entry).slice(1, -1);
    skip("link", entry, "not_ignored", `add \`/${escaped}\` (no trailing slash) to .gitignore to link it`);
  }

  const copied: string[] = [];
  const wanted = [...new Set([...input.copy, ...input.link])];
  const sources = new Map<string, string>();
  const refused = new Map<string, Reason>();
  for (const entry of wanted) {
    const source = await sourceOf(entry);
    if (REFUSALS.has(source)) refused.set(entry, source as Reason);
    else sources.set(entry, source);
  }
  let ignored: Set<string> | null = null;
  try {
    ignored = await ignoredIn(git, realRoot, [...sources.keys()]);
  } catch {
    ignored = null;
  }

  /** The copy twin of the link check: a copy the lane's own rules do not ignore would be committed with the lane (review I2). */
  async function dropUnignored(): Promise<void> {
    const present: string[] = [];
    for (const entry of copied)
      if ((await lstat(join(realWorktree, entry)).catch(() => null)) !== null) present.push(entry);
    if (present.length === 0) return;
    const kept = await ignoredIn(git, input.worktree, present, input.gitDir).catch(() => new Set<string>());
    for (const entry of present) {
      if (kept.has(entry)) continue;
      // Fail closed: a copy that stays is committed with the lane, so preparation fails (the caller undoes the lane).
      await rm(join(realWorktree, entry), { recursive: true, force: true }).catch(() => {
        throw new Error("could not remove a copy the lane does not ignore");
      });
      skip("copy", entry, "not_ignored", `add \`/${quoted(entry).slice(1, -1)}\` to .gitignore to copy it`);
    }
  }

  const run = async (kind: "copy" | "link", entries: readonly string[]): Promise<void> => {
    for (const entry of entries) {
      input.signal?.throwIfAborted();
      if (overFiles) break;
      const source = sources.get(entry);
      const why = refused.get(entry);
      if (source === undefined) {
        skip(kind, entry, why ?? "failed");
        continue;
      }
      if (ignored === null || !ignored.has(entry)) {
        skip(kind, entry, "not_ignored");
        continue;
      }
      if ((await lstat(join(realWorktree, entry)).catch(() => null)) !== null) {
        skip(kind, entry, "exists");
        continue;
      }
      if (!(await ensureParent(realWorktree, entry))) {
        skip(kind, entry, "outside");
        continue;
      }
      try {
        await (kind === "copy" ? copyEntry(entry, source) : linkEntry(entry, source));
      } catch {
        skip(kind, entry, "failed");
      }
    }
  };
  await run("copy", input.copy);
  if (overFiles) throw new CopyLimitError();
  input.signal?.throwIfAborted();
  await dropUnignored();
  await run("link", input.link);
  input.signal?.throwIfAborted();
  return { skipped };
}
