import { lstat, mkdir } from "node:fs/promises";
import { parseRawDiff } from "./diff-lists.ts";
import { removeStale } from "./restore-remove.ts";
import { walkFolder } from "./restore-walk.ts";
import { PAP_IDENTITY, GitError, type GitRunner } from "./runner.ts";
import { batches, headOf, type LeftEntry, snapshotTree } from "./snapshot.ts";

export const CHECKPOINT_PREFIX = "refs/pap/checkpoints";

const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: PAP_IDENTITY.name,
  GIT_AUTHOR_EMAIL: PAP_IDENTITY.email,
  GIT_COMMITTER_NAME: PAP_IDENTITY.name,
  GIT_COMMITTER_EMAIL: PAP_IDENTITY.email,
} as const;
const STEP_TIMEOUT_MS = 60_000;
const GITLINK = "160000";

/** `refs/pap/checkpoints/<laneId>/e/<entryId>`, `…/root` or `…/undo` (M9R53): the only refs pap writes. */
export function checkpointRef(laneId: string, key: { readonly entryId: string } | "root" | "undo"): string {
  return typeof key === "string"
    ? `${CHECKPOINT_PREFIX}/${laneId}/${key}`
    : `${CHECKPOINT_PREFIX}/${laneId}/e/${key.entryId}`;
}

/**
 * Snapshots the lane and commits the tree as pap, on top of HEAD. The caller writes the ref
 * (`update-ref --no-deref <ref> <commit>`), unless its prompt was released meanwhile (Task 15). No branch or HEAD moves.
 */
export async function captureCheckpoint(
  git: GitRunner,
  root: string,
  gitDir: string,
  indexDir: string,
  ref: string,
): Promise<{ commit: string; tree: string; skipped: number; left: readonly LeftEntry[] }> {
  const { tree, skipped, left } = await snapshotTree(git, root, gitDir, indexDir);
  const head = await headOf(git, root, gitDir);
  const made = await git.run(root, ["commit-tree", tree, ...(head === null ? [] : ["-p", head])], {
    gitDir,
    env: IDENTITY_ENV,
    input: Buffer.from(`pap checkpoint ${ref.slice(CHECKPOINT_PREFIX.length + 1)}\n`),
  });
  return { commit: made.stdout.toString("utf8").trim(), tree, skipped, left };
}

/**
 * Puts the lane's files back to a checkpoint (M9R55, changed by fix rounds 1 and 2). The lane equals `undo` (the capture
 * taken just before, under the lane lock), so only the paths that differ between `undo` and the target are touched:
 * those the target holds are written with a listed `restore` (worktree only), those only `undo` held are removed one by
 * one. Nothing else is deleted or overwritten. A file `undo` left out (over the size limit, unreadable) or never saw
 * (ignored, even if a `.gitignore` the restore reverted ignored it later) stays and is returned in `left`; so does a
 * folder that holds such a file, or any entry undo did not hold (ignored files), where the target has a file (`conflict`:
 * the folder and its contents stay, and the foreign entries are listed with the reason `ignored`, up to 50). Every git
 * call runs with `--git-dir` and `--work-tree` pinned; the root must be a real folder (a symlink is refused), or be
 * gone, and is recreated. No removal follows a symlink.
 */
export async function restoreCheckpoint(
  git: GitRunner,
  root: string,
  gitDir: string,
  commit: string,
  undo: { readonly commit: string; readonly left: readonly LeftEntry[] },
  /** Test seam: how many entries of a folder the walk reads before it calls the folder a conflict. */
  walkLimit?: number,
): Promise<{ removed: number; left: LeftEntry[] }> {
  const info = await lstat(root).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return null;
    throw error;
  });
  if (info !== null && !info.isDirectory()) throw new GitError("failed");
  await mkdir(root, { recursive: true });
  const options = { gitDir, timeoutMs: STEP_TIMEOUT_MS };
  if (info === null) {
    // The folder was gone: nothing in it to protect, and no capture of it to diff against. Write the whole checkpoint.
    await git.run(root, ["restore", `--source=${commit}`, "--worktree", "--staged", "--", "."], options);
    await git.run(root, ["reset", "--quiet", "--", "."], options);
    return { removed: 0, left: [] };
  }
  const present: LeftEntry[] = [];
  for (const entry of undo.left) {
    const exists = await lstat(Buffer.concat([Buffer.from(`${root}/`), entry.path])).then(
      () => true,
      () => false,
    );
    if (exists) present.push(entry);
  }
  const kept = present.map((entry) => entry.path.toString("latin1"));
  const under = (ancestor: string, path: string): boolean =>
    path === ancestor || path.startsWith(`${ancestor}/`);

  // What differs between `undo` (the lane as it was a moment ago) and the target (tree to tree: no filter, no worktree read).
  const diff = await git.run(root, ["diff", "--raw", "-z", "--no-abbrev", undo.commit, commit, "--"], {
    ...options,
    maxBytes: 64 * 1024 * 1024,
  });
  const changes = parseRawDiff(diff.stdout, "latin1").filter(
    (entry) => entry.oldMode !== GITLINK && entry.newMode !== GITLINK,
  );
  const held = new Set(changes.filter((entry) => entry.status === "D").map((entry) => entry.path));
  const toWrite: string[] = [];
  const conflicts = new Set<string>();
  const foreign: string[] = [];
  for (const entry of changes) {
    if (entry.status === "D") continue;
    // A file undo left out is in the way, or is the path itself: it is not overwritten.
    if (kept.some((path) => under(path, entry.path))) continue;
    // The target holds a file where the lane has a folder holding a left-in-place file: the folder stays.
    if (kept.some((path) => under(entry.path, path))) {
      conflicts.add(entry.path);
      continue;
    }
    // A lane folder where the target has a file goes only when undo held everything in it (undo brings it back).
    const folder = await lstat(
      Buffer.concat([Buffer.from(`${root}/`), Buffer.from(entry.path, "latin1")]),
    ).then(
      (stat) => stat.isDirectory(),
      () => false,
    );
    const verdict = folder ? await walkFolder(root, entry.path, held, walkLimit) : null;
    if (verdict?.conflict) {
      conflicts.add(entry.path);
      foreign.push(...verdict.foreign.filter((path) => !kept.includes(path)));
    } else toWrite.push(entry.path);
  }
  for (const group of batches(toWrite)) {
    const input = Buffer.from(group.map((path) => `${path}\0`).join(""), "latin1");
    await git.run(
      root,
      ["restore", `--source=${commit}`, "--worktree", "--pathspec-from-file=-", "--pathspec-file-nul"],
      {
        ...options,
        input,
      },
    );
  }
  const candidates = changes
    .filter((entry) => entry.status === "D")
    .filter(
      (entry) =>
        !kept.some((path) => under(path, entry.path)) &&
        ![...conflicts].some((path) => under(path, entry.path)),
    )
    .map((entry) => entry.path);
  // The target's own ignore rules are in the worktree now: a path they ignore was outside that checkpoint's scope.
  const ignored = await ignoredAmong(git, root, options, candidates);
  let removed = 0;
  for (const path of candidates) {
    if (ignored.has(path)) continue;
    if (await removeStale(root, path)) removed += 1;
  }
  await git.run(root, ["reset", "--quiet", "--", "."], options);
  const left: LeftEntry[] = [
    ...present,
    ...[...conflicts].map((path): LeftEntry => ({ path: Buffer.from(path, "latin1"), reason: "conflict" })),
    ...foreign.map((path): LeftEntry => ({ path: Buffer.from(path, "latin1"), reason: "ignored" })),
    ...[...ignored].map((path): LeftEntry => ({ path: Buffer.from(path, "latin1"), reason: "ignored" })),
  ];
  return { removed, left };
}

/** Which of the paths (latin1 strings) the lane's ignore rules ignore, one batched `check-ignore` per group; tracked paths count too. */
async function ignoredAmong(
  git: GitRunner,
  root: string,
  options: { readonly gitDir: string; readonly timeoutMs: number },
  paths: readonly string[],
): Promise<Set<string>> {
  const found = new Set<string>();
  const ask = async (group: readonly string[]): Promise<void> => {
    const input = Buffer.from(group.map((path) => `./${path}\0`).join(""), "latin1");
    const out = await git.run(root, ["check-ignore", "-z", "--stdin", "--no-index"], {
      ...options,
      input,
      okCodes: [0, 1],
    });
    for (const name of out.stdout.toString("latin1").split("\0"))
      if (name.startsWith("./")) found.add(name.slice(2));
  };
  for (const group of batches(paths)) {
    try {
      await ask(group);
    } catch (error) {
      if (!(error instanceof GitError) || error.kind !== "failed") throw error;
      // One path git cannot judge (beyond a symlink) sinks the batch: ask one by one, and leave an unjudged path alone.
      for (const path of group) await ask([path]).catch(() => void found.add(path));
    }
  }
  return found;
}

/** Every checkpoint ref of a lane, `refname` → commit. */
export async function laneRefs(
  git: GitRunner,
  root: string,
  gitDir: string,
  laneId: string,
): Promise<Map<string, string>> {
  const listed = await git.run(
    root,
    [
      "for-each-ref",
      "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
      `${CHECKPOINT_PREFIX}/${laneId}/`,
    ],
    { gitDir },
  );
  const refs = new Map<string, string>();
  for (const line of listed.stdout.toString("utf8").split("\n")) {
    const [name, oid] = line.split("\0");
    if (name !== undefined && oid !== undefined && name !== "") refs.set(name, oid);
  }
  return refs;
}

/** The keys `turnRanges` reads: the entry ids that have a checkpoint, and `root`. `undo` is not a turn boundary. */
export function entryIdsOf(refs: ReadonlyMap<string, string>, laneId: string): Set<string> {
  const base = `${CHECKPOINT_PREFIX}/${laneId}/`;
  const keys = new Set<string>();
  for (const name of refs.keys()) {
    if (name === `${base}root`) keys.add("root");
    else if (name.startsWith(`${base}e/`)) keys.add(name.slice(base.length + 2));
  }
  return keys;
}

export async function deleteLaneRefs(
  git: GitRunner,
  root: string,
  gitDir: string,
  laneId: string,
): Promise<void> {
  for (const name of (await laneRefs(git, root, gitDir, laneId)).keys())
    await git.run(root, ["update-ref", "--no-deref", "-d", name], { gitDir });
}
