import { dirname } from "node:path";
import { CliError } from "../open-home.ts";

export interface CodeStat {
  readonly uid: number;
  readonly mode: number;
}
export type StatCode = (path: string) => CodeStat;

/** N1: every path and each of its folders up to `/`, once: a user-owned folder above a root-owned unpack lets pap's user swap it. */
function withAncestors(paths: readonly string[]): string[] {
  const all = new Set<string>();
  for (const path of paths)
    for (let at = path; !all.has(at); at = dirname(at)) {
      all.add(at);
      if (dirname(at) === at) break;
    }
  return [...all];
}

/**
 * Final review I3 (RT-22): `sudo pap vm setup` runs pap's own program, its pins and the running Node as root. Without
 * `--dev-from-tree` each, and every folder above it up to `/` (N1), must be owned by root and writable by neither its group nor
 * others (the rule `--assets` applies to its file: no sticky-bit exemption), else a compromise of pap's user becomes root at the next setup.
 */
export function assertRootOwnedCode(paths: readonly string[], stat: StatCode): void {
  const loose: string[] = [];
  for (const path of withAncestors(paths)) {
    let facts: CodeStat;
    try {
      facts = stat(path);
    } catch {
      throw new CliError(`cannot inspect ${path}: refusing to run it as root`);
    }
    if (facts.uid !== 0 || (facts.mode & 0o022) !== 0) loose.push(path);
  }
  if (loose.length > 0)
    throw new CliError(
      `pap vm setup would run code that is not root-owned or that others can change, as root: ${loose.join(", ")}. ` +
        "Run it from a release archive unpacked as root (--dev-from-tree is for testing only).",
    );
}
