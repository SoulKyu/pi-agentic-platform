import { BRANCH_PATTERN, EntryId, LaneId } from "@pap/contracts";
import type { CallShape, SubcommandRule } from "./allowlist.ts";

const OID = /[0-9a-f]{40}|[0-9a-f]{64}/;
const isOid = (text: string | undefined): boolean =>
  text !== undefined && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(text);
const isBranch = (text: string | undefined): boolean =>
  text !== undefined && text.length <= 200 && BRANCH_PATTERN.test(text);
const isAbsolute = (text: string | undefined): boolean => text !== undefined && text.startsWith("/");
/** `refs/pap/checkpoints/<laneId>/e/<entryId>`, `…/root`, `…/undo` (M9R53): the only refs pap writes or deletes. */
function isCheckpointRef(ref: string | undefined): boolean {
  const match = /^refs\/pap\/checkpoints\/([^/]+)\/(?:e\/([^/]+)|root|undo)$/.exec(ref ?? "");
  return (
    match !== null &&
    LaneId.safeParse(match[1]).success &&
    (match[2] === undefined || EntryId.safeParse(match[2]).success)
  );
}
/** `refs/heads/<B>:refs/heads/<B>`, the same branch on both sides: no `+`, no deletion, no other ref (M9R9). */
function isSameBranchRefspec(spec: string | undefined): boolean {
  const match = /^refs\/heads\/([^:]+):refs\/heads\/([^:]+)$/.exec(spec ?? "");
  return match !== null && match[1] === match[2] && isBranch(match[1]);
}
const onlyDot = ({ before, after }: CallShape): boolean =>
  before.length === 0 && after.length === 1 && after[0] === ".";
const onePath = ({ before, after }: CallShape): boolean =>
  after.length === 0 && before.length === 1 && isAbsolute(before[0]);

/** M9's calls, each option as its caller spells it and each call's exact shape (the § at a glance table). */
export const LANE_SUBCOMMANDS: Readonly<Record<string, SubcommandRule>> = {
  "rev-parse": {
    options: ["--show-toplevel", "--abbrev-ref", "--git-common-dir", "--git-path", "--verify", "--quiet"],
    positional: true,
  },
  diff: {
    options: [
      "--numstat",
      "-z",
      "--ignore-submodules=dirty",
      "--no-ext-diff",
      "--no-textconv",
      "--raw",
      // Task 14 fix round 1: the index against HEAD, to find the gitlinks an `add` made.
      "--cached",
      "-M",
      "--no-renames",
      "--no-abbrev",
      "--no-color",
      "-U3",
    ],
    positional: true,
  },
  "check-ref-format": {
    options: ["--branch"],
    required: ["--branch"],
    positional: true,
    shape: ({ before, after }) => after.length === 0 && before.length === 1,
  },
  branch: {
    options: ["--no-track", "-d", "-D"],
    positional: true,
    shape: ({ before, after, options }) =>
      after.length === 0 &&
      options.length === 1 &&
      (options[0] === "--no-track"
        ? before.length === 2 && isBranch(before[0]) && isOid(before[1])
        : before.length === 1 && isBranch(before[0])),
  },
  worktree: {
    options: [],
    positional: true,
    nested: {
      add: {
        options: ["--lock", "--reason=pap-creating"],
        required: ["--lock", "--reason=pap-creating"],
        positional: true,
        shape: ({ before, after }) =>
          after.length === 0 && before.length === 2 && isAbsolute(before[0]) && isBranch(before[1]),
      },
      unlock: { options: [], positional: true, shape: onePath },
      // MC1 I2: without `--force` git runs `status` in the lane, which runs a lane-scope filter driver.
      remove: { options: ["--force"], required: ["--force"], positional: true, shape: onePath },
      prune: { options: [], positional: false },
      list: { options: ["--porcelain", "-z"], positional: false },
    },
  },
  "for-each-ref": {
    options: [
      "--format=%(refname)",
      "--format=%(refname)%00%(objectname)%00%(committerdate:unix)",
      "--sort=-committerdate",
      "--count=500",
      // Read-only: only the refs whose tip HEAD already contains (the lineage test of `lanes.preview`).
      "--merged=HEAD",
    ],
    positional: true,
    shape: ({ before, after }) =>
      after.length === 0 && before.length >= 1 && before.every((p) => p.startsWith("refs/")),
  },
  "rev-list": { options: ["--count", "--left-right"], positional: true },
  "merge-base": {
    options: ["--is-ancestor"],
    positional: true,
    // Lineage test of trust inheritance: one commit id against HEAD, nothing else.
    shape: ({ before, after, options }) =>
      !options.includes("--is-ancestor") ||
      (after.length === 0 && before.length === 2 && isOid(before[0]) && before[1] === "HEAD"),
  },
  "read-tree": {
    options: ["--empty"],
    positional: true,
    temporaryIndex: true,
    shape: ({ before, after, options }) =>
      after.length === 0 &&
      (options.includes("--empty") ? before.length === 0 : before.length === 1 && before[0] === "HEAD"),
  },
  "write-tree": { options: [], positional: false, temporaryIndex: true },
  "commit-tree": {
    options: ["-p"],
    positional: true,
    shape: ({ before, after, options }) =>
      after.length === 0 && before.length === (options.includes("-p") ? 2 : 1) && before.every(isOid),
  },
  "update-ref": {
    // MC1 I1: without `--no-deref` a symbolic ref under refs/pap/ moves or deletes the branch it points at.
    options: ["-d", "--no-deref"],
    required: ["--no-deref"],
    positional: true,
    shape: ({ before, after, options }) =>
      after.length === 0 &&
      isCheckpointRef(before[0]) &&
      (options.includes("-d") ? before.length === 1 : before.length === 2 && isOid(before[1])),
  },
  // MC1 I3: one staging shape, the paths on stdin (stage.ts). `-A -- .` and `-u -- .` run a nested repository's filter.
  add: {
    options: ["--pathspec-from-file=-", "--pathspec-file-nul"],
    required: ["--pathspec-from-file=-", "--pathspec-file-nul"],
    positional: false,
  },
  // Fix round 1 (MC2): takes a gitlink an `add` made out of the index only; the worktree is never touched.
  rm: {
    options: ["--cached", "-f", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"],
    required: ["--cached", "-f", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul"],
    positional: false,
  },
  commit: {
    options: ["--file=-", "--no-gpg-sign", "--quiet"],
    required: ["--file=-", "--no-gpg-sign"],
    positional: true,
    shape: ({ before, after }) =>
      before.length === 0 && after.length >= 1 && after.every((p) => p.startsWith("./")),
  },
  restore: {
    options: [
      { prefix: "--source=", value: OID },
      "--worktree",
      "--staged",
      "--pathspec-from-file=-",
      "--pathspec-file-nul",
    ],
    required: ["--worktree"],
    positional: true,
    // Whole tree (`--staged -- .`), or an explicit list on stdin and the worktree only (task 11 fix round 2: a restore
    // that leaves some paths alone; stage.ts caps the list).
    shape: (call) => {
      if (!call.options.some((option) => option.startsWith("--source="))) return false;
      const list =
        call.options.includes("--pathspec-from-file=-") && call.options.includes("--pathspec-file-nul");
      return call.options.includes("--staged")
        ? !list && onlyDot(call)
        : list && call.before.length === 0 && call.after.length === 0 && call.options.length === 4;
    },
  },
  reset: { options: ["--quiet"], required: ["--quiet"], positional: true, shape: onlyDot },
  remote: {
    options: [],
    positional: true,
    nested: {
      "get-url": {
        options: ["--push", "--all"],
        required: ["--push", "--all"],
        positional: true,
        shape: ({ before, after }) => after.length === 0 && before.length === 1 && before[0] === "origin",
      },
    },
  },
  push: {
    options: ["--porcelain", "--set-upstream"],
    required: ["--porcelain", "--set-upstream"],
    positional: true,
    remote: true,
    shape: ({ before, after }) =>
      after.length === 0 && before.length === 2 && before[0] === "origin" && isSameBranchRefspec(before[1]),
  },
};
