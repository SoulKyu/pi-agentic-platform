import { FILE_LIMITS, type FileEntry, type FileMeta } from "@pap/contracts";

/** Folders kept open per root; the least recently opened is forgotten first (M8R76). */
export const MAX_EXPANDED = 20;
export const MAX_TABS = 8;
/** What the viewer loads of one file: past this it says "too large" and offers the download instead of Load more. */
export const VIEW_LIMIT_BYTES = 8 * FILE_LIMITS.readChunkBytes;

export interface Folder {
  readonly status: "ready" | "error";
  /** The code of the failed listing (`not_found`...), for the message. */
  readonly code?: string;
  readonly entries: readonly FileEntry[];
  readonly truncated: boolean;
}

export type Lock = "protected" | "outside";

export interface TreeRow {
  readonly path: string;
  readonly name: string;
  readonly depth: number;
  readonly entry: FileEntry;
  readonly expandable: boolean;
  readonly openable: boolean;
  readonly expanded: boolean;
  readonly lock: Lock | null;
}

const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A file name as text for a person: invisible and bidi characters dropped, clipped to the name limit. */
export function displayName(name: string): string {
  return Array.from(name.replace(INVISIBLE, "")).slice(0, FILE_LIMITS.nameBytes).join("");
}

export const joinPath = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);
export const baseName = (path: string): string => displayName(path.slice(path.lastIndexOf("/") + 1));

/**
 * The title of each tab, in order: the base name, and for files of the same name the shortest tail of their parent
 * folders that tells each of them apart from the others ("index.ts (a/x)").
 */
export function tabTitles(paths: readonly string[]): string[] {
  const parents = paths.map((path) =>
    path
      .slice(0, path.lastIndexOf("/"))
      .split("/")
      .map(displayName)
      .filter((segment) => segment !== ""),
  );
  const tail = (index: number, depth: number): string => (parents[index] ?? []).slice(-depth).join("/");
  return paths.map((path, index) => {
    const name = baseName(path);
    const same = paths.flatMap((other, at) => (at !== index && baseName(other) === name ? [at] : []));
    if (same.length === 0) return name;
    const deepest = Math.max(...[index, ...same].map((at) => parents[at]?.length ?? 0));
    for (let depth = 1; depth <= deepest; depth++) {
      if (same.every((at) => tail(at, depth) !== tail(index, depth)))
        return `${name} (${tail(index, depth)})`;
    }
    return `${name} (${tail(index, deepest)})`;
  });
}

/** What a row may do. A locked entry (protected, or a link leaving the project) is listed and nothing else (M8R95). */
export function rowAccess(entry: FileEntry): {
  expandable: boolean;
  openable: boolean;
  lock: Lock | null;
} {
  if (entry.protected) return { expandable: false, openable: false, lock: "protected" };
  if (entry.link === "outside") return { expandable: false, openable: false, lock: "outside" };
  if (entry.kind === "dir") return { expandable: true, openable: false, lock: null };
  if (entry.kind === "link" && entry.link === "inside") {
    return { expandable: entry.linkDir, openable: !entry.linkDir, lock: null };
  }
  return { expandable: false, openable: entry.kind === "file", lock: null };
}

/** The rows on screen, in order: a folder's children follow it when it is expanded and listed. */
export function visibleRows(
  root: string,
  expanded: readonly string[],
  folders: ReadonlyMap<string, Folder>,
): TreeRow[] {
  const open = new Set(expanded);
  const rows: TreeRow[] = [];
  const walk = (dir: string, depth: number) => {
    for (const entry of folders.get(dir)?.entries ?? []) {
      const path = joinPath(dir, entry.name);
      const access = rowAccess(entry);
      const isOpen = access.expandable && open.has(path);
      rows.push({
        path,
        name: displayName(entry.name),
        depth,
        entry,
        ...access,
        expanded: isOpen,
      });
      if (isOpen) walk(path, depth + 1);
    }
  };
  walk(root, 0);
  return rows;
}

/** Marks `path` as the most recently opened folder; past the cap the oldest goes, but never an ancestor of `path`. */
export function touchExpanded(expanded: readonly string[], path: string): string[] {
  const next = [...expanded.filter((entry) => entry !== path), path];
  while (next.length > MAX_EXPANDED) {
    const oldest = next.findIndex((entry) => !path.startsWith(`${entry}/`) && entry !== path);
    if (oldest < 0) break;
    next.splice(oldest, 1);
  }
  return next;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "ico", "svg"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const extensionOf = (path: string): string => path.slice(path.lastIndexOf(".") + 1).toLowerCase();

export type ViewKind = "binary" | "image" | "markdown" | "text";

/** M8R94: text and code, Markdown and images preview; any other binary downloads. */
export function viewKind(path: string, meta: Pick<FileMeta, "binary">): ViewKind {
  const extension = path.includes(".") ? extensionOf(path) : "";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  if (meta.binary) return "binary";
  return MARKDOWN_EXTENSIONS.has(extension) ? "markdown" : "text";
}

/** The sandboxed raw route: an inline image, or (with `download`) an attachment. */
export const rawUrl = (path: string, download = false): string =>
  `/files/raw?path=${encodeURIComponent(path)}${download ? "&download=1" : ""}`;

/**
 * The open tabs after opening `path`: at most MAX_TABS, the oldest clean one closed first. A dirty tab is never
 * closed here: when all are dirty the answer is null and the file is not opened.
 */
export function openTab(
  tabs: readonly string[],
  path: string,
  dirty: ReadonlySet<string>,
): readonly string[] | null {
  if (tabs.includes(path)) return tabs;
  if (tabs.length < MAX_TABS) return [...tabs, path];
  const oldestClean = tabs.findIndex((tab) => !dirty.has(tab));
  if (oldestClean < 0) return null;
  return [...tabs.filter((_, index) => index !== oldestClean), path];
}

/** A size for a person: bytes below 1 KB, then whole KB or MB. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
