import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { kernelResolve, tooLong } from "./kernel-path.ts";
import { REWRITTEN, UNICODE_SPACE } from "./read-target.ts";
import { asPiResolves } from "./target-path.ts";

/** Real paths, checked once at worker start (`realVmRoots`): a root that is a link or not a folder stops the worker. */
export interface VmFileRoots {
  readonly writable: readonly string[];
  readonly readOnly: readonly string[];
}
export type VmPathVerdict = { readonly ok: true } | { readonly ok: false; readonly reason: VmPathRefusal };
export type VmPathRefusal =
  "unreadable path" | "rewritten path" | "missing" | "link" | "not a file" | "outside this agent's folders";

export const inside = (target: string, root: string): boolean =>
  target === root || target.startsWith(`${root}/`);
const refuse = (reason: VmPathRefusal): VmPathVerdict => ({ ok: false, reason });
const isMissing = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};
async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}
/** The real path of the nearest existing ancestor joined with the rest: where a new file would land. */
async function realOrNearest(p: string): Promise<string> {
  const rest: string[] = [];
  let current = p;
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** The folders a VM agent's file tools reach (spec §5): its own three, and Pi's skill and package folders read-only (R26). */
export const vmFileFolders = (layout: {
  home: string;
  knowledge: string;
  inbox: string;
  piAgentDir: string;
}) => ({
  writable: [layout.home, layout.knowledge, layout.inbox],
  readOnly: ["skills", "npm", "git", "local"].map((name) => `${layout.piAgentDir}/${name}`),
});

/** The same as real folders, once at worker start; a writable root that is a link or not a folder stops the worker. */
export async function realVmRoots(layout: Parameters<typeof vmFileFolders>[0]): Promise<VmFileRoots> {
  const folders = vmFileFolders(layout);
  const real = async (dir: string, required: boolean): Promise<string | null> => {
    const info = await lstat(dir).catch((error: unknown) =>
      !required && isMissing(error) ? null : Promise.reject(error),
    );
    if (info === null) return null;
    if (!info.isDirectory() || (await realpath(dir)) !== path.resolve(dir))
      throw new Error("vm files: a root is not a real folder");
    return path.resolve(dir);
  };
  const writable = await Promise.all(folders.writable.map((dir) => real(dir, true)));
  const readOnly = await Promise.all(folders.readOnly.map((dir) => real(dir, false)));
  return { writable: writable as string[], readOnly: readOnly.filter((dir): dir is string => dir !== null) };
}

/**
 * Spec §5, RT-01: a path Pi's file tools name in a VM agent stays in the agent's folders. Judged before the call; the tools'
 * operations (`vm-files/ops.ts`) enforce it again at open time, one component at a time, so a link planted between the two
 * is refused, not followed. A path Pi would rewrite (`~`, `@`, `file:`, a Unicode space) is refused: Pi would open another
 * path than the one judged. A read names an existing path; a write never lands on a link, dangling or not.
 */
export async function judgeVmPath(
  raw: unknown,
  cwd: string,
  roots: VmFileRoots,
  write: boolean,
): Promise<VmPathVerdict> {
  if (typeof raw !== "string" || raw === "" || raw.includes("\0") || tooLong(raw))
    return refuse("unreadable path");
  if (REWRITTEN.test(raw) || UNICODE_SPACE.test(raw)) return refuse("rewritten path");
  const allowed = write ? roots.writable : [...roots.writable, ...roots.readOnly];
  const within = (p: string) => allowed.some((root) => inside(p, root));
  for (const spelling of new Set([asPiResolves(raw), raw])) {
    const lexical = path.resolve(cwd, spelling);
    if (!within(lexical)) return refuse("outside this agent's folders");
    // The real-path checks come first: a planted `home/r -> /` must not let the leaf verdicts tell apart what exists outside.
    const landing = await Promise.all([realOrNearest(lexical), kernelResolve(cwd, spelling)]).catch(() => null);
    if (landing === null || !landing.every(within)) return refuse("outside this agent's folders");
    const leaf = await lstatOrNull(lexical);
    if (leaf?.isSymbolicLink()) return refuse("link");
    if (!write && leaf === null) return refuse("missing");
    if (write && leaf !== null && !leaf.isFile()) return refuse("not a file");
  }
  return { ok: true };
}
