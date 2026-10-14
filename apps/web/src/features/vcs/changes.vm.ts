import type { VcsFile } from "@pap/contracts";
import type { ChipTone } from "@pap/ui";
import { formatDiffCounts } from "@pap/ui";

type Kind = VcsFile["kind"];

/** The word of each kind: a status is never shown by colour alone. */
export const KIND_KEYS = {
  modified: "changes.kind.modified",
  added: "changes.kind.added",
  deleted: "changes.kind.deleted",
  renamed: "changes.kind.renamed",
  copied: "changes.kind.copied",
  typechange: "changes.kind.typechange",
  untracked: "changes.kind.untracked",
  conflicted: "changes.kind.conflicted",
} as const satisfies Record<Kind, string>;

/** The chip tone of each kind (tokens only: `ok` for added, `err` for deleted and conflicts). */
export function kindTone(kind: Kind): ChipTone {
  switch (kind) {
    case "modified":
      return "run";
    case "added":
      return "ok";
    case "deleted":
    case "conflicted":
      return "err";
    case "untracked":
      return "ext";
    case "renamed":
    case "copied":
    case "typechange":
      return "mut";
  }
}

export type GroupId = "conflicts" | "changes" | "untracked";
export interface ChangeGroup {
  readonly id: GroupId;
  readonly files: readonly VcsFile[];
}

const GROUP_KEYS = {
  conflicts: "changes.group.conflicts",
  changes: "changes.group.changes",
  untracked: "changes.group.untracked",
} as const satisfies Record<GroupId, string>;
export const groupKey = (id: GroupId) => GROUP_KEYS[id];

const groupOf = (file: VcsFile): GroupId =>
  file.kind === "conflicted" ? "conflicts" : file.kind === "untracked" ? "untracked" : "changes";
const byPath = (a: VcsFile, b: VcsFile): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** Conflicts, then changes, then untracked; each ordered by path; a group without files is left out. */
export function groupFiles(files: readonly VcsFile[]): ChangeGroup[] {
  const groups: GroupId[] = ["conflicts", "changes", "untracked"];
  return groups
    .map((id) => ({ id, files: files.filter((file) => groupOf(file) === id).sort(byPath) }))
    .filter((group) => group.files.length > 0);
}

/** `+12 −3`, or null when git gave no counts (binary files, untracked files). */
export function countsOf(file: VcsFile): string | null {
  if (file.binary || file.additions === null || file.deletions === null) return null;
  return formatDiffCounts(file.additions, file.deletions);
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const PATH_POINTS = 512;

/** A repository path as text for a person: invisible and bidi characters dropped, clipped. */
export function displayPath(path: string): string {
  const points = Array.from(path.replace(INVISIBLE, ""));
  return points.length > PATH_POINTS ? `${points.slice(0, PATH_POINTS).join("")}…` : points.join("");
}

/** The path of a row; a rename or a copy reads `old → new`. */
export function rowPath(file: VcsFile): string {
  const path = displayPath(file.path);
  return file.oldPath === null ? path : `${displayPath(file.oldPath)} → ${path}`;
}

export const absolutePath = (root: string, path: string): string =>
  root === "/" ? `/${path}` : `${root}/${path}`;

/** Whether `cwd` is the root or a folder under it (`/pp` is not under `/p`). */
export const inRoot = (root: string, cwd: string): boolean =>
  root === "/" ? cwd.startsWith("/") : cwd === root || cwd.startsWith(`${root}/`);
