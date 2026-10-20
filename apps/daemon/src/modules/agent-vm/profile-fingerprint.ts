import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** What an unchanged profile looks like from outside: names, sizes and mtimes (no content is read). */
export interface Fingerprint {
  readonly digest: string;
  /** The newest mtime seen: a file touched around the preparation cannot be told from one copied before the touch. */
  readonly newestMs: number;
}

/** The folders whose own mtime moves when a package is installed or removed beside the copied ones. */
const WATCHED_FOLDERS = ["", "npm", "npm/node_modules", "git", "skills"];

/**
 * I4: the preparation copies, scans and hashes the whole Pi profile, so most starts must not repeat it. The inputs are the files
 * directly in the agent folder (settings, models, the adapters' configs), the folders a package is installed into, and every
 * copied root with everything under it (links are not followed). `salt` holds what is not on disk here: the base key, the
 * known secrets, the home and the providers.
 */
export function profileFingerprint(agentDir: string, roots: readonly string[], salt: string): Fingerprint {
  const hash = createHash("sha256").update(`pap-profile-fingerprint-1\0${salt}\0`);
  let newestMs = 0;
  const add = (path: string, label: string): ReturnType<typeof lstatSync> | null => {
    let stat: ReturnType<typeof lstatSync>;
    try {
      stat = lstatSync(path);
    } catch {
      hash.update(`${label}\0missing\n`);
      return null;
    }
    hash.update(`${label}\0${stat.mode}\0${stat.size}\0${stat.mtimeMs}\n`);
    newestMs = Math.max(newestMs, stat.mtimeMs);
    return stat;
  };
  const walk = (dir: string, label: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const stat = add(join(dir, name), `${label}/${name}`);
      if (stat?.isDirectory()) walk(join(dir, name), `${label}/${name}`);
    }
  };
  for (const folder of WATCHED_FOLDERS) add(join(agentDir, folder), `watched:${folder}`);
  for (const name of readdirSync(agentDir).sort()) {
    const stat = lstatSync(join(agentDir, name));
    if (!stat.isDirectory()) add(join(agentDir, name), `top:${name}`);
  }
  for (const root of [...roots].sort()) {
    add(root, `root:${root}`);
    walk(root, `root:${root}`);
  }
  return { digest: hash.digest("hex"), newestMs };
}
