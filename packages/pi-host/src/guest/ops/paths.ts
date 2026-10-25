import { closeSync } from "node:fs";
import type { BoxOpError } from "@pap/contracts/pi-host";
import { closeQuietly, openDirAt, openRootDir } from "../../nofollow.ts";
import type { GithubDeps } from "./github-env.ts";

/** What a guest operation answers when it cannot: the daemon maps the code on, the message is never sent. */
export class OpError extends Error {
  readonly code: BoxOpError;
  constructor(code: BoxOpError) {
    super(code);
    this.code = code;
  }
}

/** What every operation needs: the project's folder and the guest's clock; nothing else of the guest. */
export interface OpEnv {
  /** `layout.project`: every path an operation names is this folder or below it. */
  readonly project: string;
  readonly now: () => number;
  /** The GitHub ops' share of the guest (home, `/run`, wrapper scripts, environment); absent where no op needs it. */
  readonly github?: GithubDeps;
}

const REFUSED = new Set(["ENOENT", "ENOTDIR", "ELOOP", "EISDIR", "EACCES", "EPERM", "ENXIO", "ENAMETOOLONG"]);

/** An operation's failure as the code the daemon hears: a refusal reads as `not_found`, as on the host. */
export function opErrorOf(error: unknown): OpError {
  if (error instanceof OpError) return error;
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "EEXIST") return new OpError("conflict");
  if (code !== undefined && REFUSED.has(code)) return new OpError("not_found");
  // `nofollow.ts` refuses a link, a device or a pipe with a plain message.
  if (error instanceof Error && /is not a (folder|regular file)$/.test(error.message)) {
    return new OpError("not_found");
  }
  return new OpError("failed");
}

/**
 * The names of `path` below the project: it must be the project or start with `<project>/`, and no segment may be empty,
 * `.` or `..` (nothing is normalised, so `<project>/a/../../x` is refused, not resolved).
 */
export function segmentsOf(project: string, path: string): string[] {
  if (path === project) return [];
  if (!path.startsWith(`${project}/`)) throw new OpError("not_found");
  const names = path.slice(project.length + 1).split("/");
  if (names.some((name) => name === "" || name === "." || name === ".." || name.includes("\0"))) {
    throw new OpError("not_found");
  }
  return names;
}

/** Whether the segments name `.git` or something inside it: listed and read, never written. */
export const inGit = (segments: readonly string[]): boolean => segments[0] === ".git";

/** Opens the project's folder, then each name below it from its parent's descriptor with no link followed. The caller closes the result. */
export function openFolderAt(project: string, segments: readonly string[]): number {
  let current = openRootDir(project);
  try {
    for (const name of segments) {
      const next = openDirAt(current, name);
      closeSync(current);
      current = next;
    }
  } catch (error) {
    closeQuietly(current);
    throw error;
  }
  return current;
}

/** Runs `use` on the folder `segments` names, and closes it. Failures come out as {@link OpError}. */
export function withFolder<T>(project: string, segments: readonly string[], use: (fd: number) => T): T {
  let fd = -1;
  try {
    fd = openFolderAt(project, segments);
    return use(fd);
  } catch (error) {
    throw opErrorOf(error);
  } finally {
    if (fd >= 0) closeQuietly(fd);
  }
}

/** Runs `use` on the folder holding the entry `path` names and that entry's name. */
export function withParent<T>(
  env: OpEnv,
  path: string,
  use: (parentFd: number, name: string, segments: string[]) => T,
): T {
  const segments = segmentsOf(env.project, path);
  const name = segments.pop();
  if (name === undefined) throw new OpError("not_found");
  return withFolder(env.project, segments, (fd) => use(fd, name, [...segments, name]));
}

/** The GitHub ops' deps; a guest built without them (a test of another op) answers `failed`. */
export function githubOf(env: OpEnv): GithubDeps {
  if (env.github === undefined) throw new OpError("failed");
  return env.github;
}
