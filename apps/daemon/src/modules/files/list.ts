import type { Stats } from "node:fs";
import { lstat, opendir, realpath, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { FILE_LIMITS, type FileEntry, PapError } from "@pap/contracts";
import { entryIsProtected, type Scope, within } from "../../kernel/fs/boundary.ts";
import type { Logger } from "../../kernel/logger.ts";
import { isTempName, openFolder } from "../../kernel/fs/safe-open.ts";
import { PAGE_BYTES, sizeOf } from "../../kernel/json-bytes.ts";
import { type FilesEnv, judged, refusal } from "./access.ts";
import { compareCodePoints } from "./rank.ts";
import { ALWAYS_HIDDEN, hiddenReasons } from "./visibility.ts";

/** Entries read from one folder at most; a larger folder is cut and says so (resource bound). */
export const LIST_SCAN_MAX = 20_000;
/** Entries `lstat`ed at once through the held descriptor (M8R25). */
const LSTAT_BATCH = 32;

/** An empty answer under the page's envelope. */
const ENVELOPE_BYTES = sizeOf({ entries: [], truncated: true });

async function readNames(
  folderPath: string,
  scanMax: number,
  logger: Logger,
): Promise<{ names: string[]; cut: boolean }> {
  const names: string[] = [];
  const dir = await opendir(folderPath);
  try {
    for await (const entry of dir) {
      if (names.length === scanMax) return { names, cut: true };
      names.push(entry.name);
    }
  } finally {
    await dir.close().catch((error: unknown) => {
      logger.debug("files_list_close_failed", { code: (error as { code?: unknown }).code });
    });
  }
  return { names, cut: false };
}

const UNRESOLVED: ReadonlySet<string> = new Set([
  "ENOENT",
  "ENOTDIR",
  "ELOOP",
  "EACCES",
  "EPERM",
  "ENAMETOOLONG",
]);

/** A link, resolved and judged: inside the roots, outside them, or broken (M8R25). */
async function describeLink(
  entryPath: string,
  spelled: readonly string[],
  scope: Scope,
  logger: Logger,
): Promise<Pick<FileEntry, "link" | "linkDir" | "protected">> {
  let target: string;
  try {
    target = await realpath(entryPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "";
    if (!UNRESOLVED.has(code)) throw error;
    return { link: "broken", linkDir: false, protected: spelled.some((p) => entryIsProtected(p, scope)) };
  }
  const targetStat = await stat(target).catch((error: unknown) => {
    logger.debug("files_link_stat_failed", { code: (error as { code?: unknown }).code });
    return null;
  });
  return {
    link: scope.roots.some((root) => within(root, target)) ? "inside" : "outside",
    linkDir: targetStat?.isDirectory() ?? false,
    protected: [...spelled, target].some((p) => entryIsProtected(p, scope)),
  };
}

async function describe(
  name: string,
  st: Stats,
  folderPath: string,
  spelled: readonly string[],
  scope: Scope,
  logger: Logger,
): Promise<FileEntry> {
  const base = {
    name,
    size: st.isFile() ? st.size : null,
    // The contract refuses a negative time; a file from before 1970 is listed as 1970.
    mtimeMs: Math.max(0, st.mtimeMs),
    hidden: null,
    protected: spelled.some((p) => entryIsProtected(p, scope)),
    link: null,
    linkDir: false,
  } as const;
  if (st.isDirectory()) return { ...base, kind: "dir" };
  if (st.isFile()) return { ...base, kind: "file" };
  if (!st.isSymbolicLink()) return { ...base, kind: "other" };
  return { ...base, kind: "link", ...(await describeLink(join(folderPath, name), spelled, scope, logger)) };
}

const isFolder = (entry: FileEntry): boolean =>
  entry.kind === "dir" || (entry.kind === "link" && entry.linkDir);

/** Folders first, then the rest, each by lower-cased name and then by code point (M8R24). */
export function byFoldersThenName(a: FileEntry, b: FileEntry): number {
  return (
    Number(isFolder(b)) - Number(isFolder(a)) ||
    compareCodePoints(a.name.toLowerCase(), b.name.toLowerCase()) ||
    compareCodePoints(a.name, b.name)
  );
}

/** As many entries as fit under the page size, in order. */
function fitPage(entries: FileEntry[]): { kept: FileEntry[]; cut: boolean } {
  let used = ENVELOPE_BYTES;
  for (let i = 0; i < entries.length; i++) {
    used += sizeOf(entries[i]) + 1;
    if (used > PAGE_BYTES) return { kept: entries.slice(0, i), cut: true };
  }
  return { kept: entries, cut: false };
}

export async function listFolder(
  env: FilesEnv,
  scope: Scope,
  path: string,
  showIgnored: boolean,
  scanMax: number = LIST_SCAN_MAX,
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const target = await judged(env, scope, path, "list");
  let folder;
  try {
    folder = await openFolder(target.real, target.guard);
  } catch (error) {
    throw refusal(error, env.logger);
  }
  try {
    const { names, cut } = await readNames(folder.path, scanMax, env.logger);
    // A crash mid-write leaves `.pap-<hex>.tmp` (up to 25 MiB): it is not the owner's file (MC38 m9).
    const wanted = names.filter((name) => !ALWAYS_HIDDEN.has(name) && !isTempName(name));
    const described: FileEntry[] = [];
    for (let i = 0; i < wanted.length; i += LSTAT_BATCH) {
      const batch = await Promise.all(
        wanted.slice(i, i + LSTAT_BATCH).map(async (name) => {
          try {
            const st = await lstat(join(folder.path, name));
            return await describe(
              name,
              st,
              folder.path,
              [join(path, name), join(target.real, name)],
              scope,
              env.logger,
            );
          } catch (error) {
            // Gone since the read (a race), or not ours to see: it is simply not listed.
            const mapped = refusal(error, env.logger);
            if (mapped instanceof PapError) return null;
            throw mapped;
          }
        }),
      );
      for (const entry of batch) if (entry) described.push(entry);
    }
    const root = await realpath(target.guard.root);
    const why = await hiddenReasons(
      env.git,
      root,
      relative(root, target.real),
      described.map((entry) => entry.name),
      env.logger,
    );
    const visible = described
      .map((entry): FileEntry => ({ ...entry, hidden: why(entry.name) }))
      .filter((entry) => showIgnored || entry.hidden === null)
      .sort(byFoldersThenName);
    const capped = visible.slice(0, FILE_LIMITS.listEntries);
    const { kept, cut: pageCut } = fitPage(capped);
    return { entries: kept, truncated: cut || pageCut || visible.length > capped.length };
  } finally {
    await folder.close();
  }
}
