import { closeSync, constants, fstatSync, readFileSync, writeSync } from "node:fs";
import { GatewayToken } from "@pap/contracts";
import { closeQuietly, openAt, openDirAt, openRootDir, unlinkAt } from "../nofollow.ts";

export const TOKEN_ENV = "PAP_GATEWAY_TOKEN";
const FOLDER = "pap";
const FILE = "launch";

export interface ScrubDeps {
  env: NodeJS.ProcessEnv;
  /** `/run` under Kata, the process backend's temp `run/`. */
  runDir: string;
  execPath: string;
  execArgv: readonly string[];
  argv: readonly string[];
  execve(file: string, args: readonly string[], env: NodeJS.ProcessEnv): void;
}

/** A private folder: a token must not sit where another user can enter. */
function privateFolder(runFd: number, create: boolean): number {
  const fd = openDirAt(runFd, FOLDER, create ? { create: 0o700 } : {});
  if ((fstatSync(fd).mode & 0o077) !== 0) {
    closeSync(fd);
    throw new Error(`${FOLDER} is not private`);
  }
  return fd;
}

/**
 * R24, the entry's first act. `/proc/<pid>/environ` keeps the initial environment block, so deleting the variable is not
 * enough. With the token in the environment: park it in `<run>/pap/launch` (0700 folder, 0600 file, O_CREAT | O_EXCL |
 * O_NOFOLLOW) and re-execute this program without it; `execve` replaces the process, so this returns `null` only when the
 * injected `execve` returns. Without it (the new image): read the file once, unlink it and return the token, which the
 * caller keeps in memory. Throws, naming no token, when the file is there already, is a link, is readable by others, is
 * missing or holds no token.
 */
export function takeGatewayToken(deps: ScrubDeps): string | null {
  const runFd = openRootDir(deps.runDir);
  try {
    const token = deps.env[TOKEN_ENV];
    return token === undefined ? readOnce(runFd) : park(runFd, token, deps);
  } finally {
    closeSync(runFd);
  }
}

function park(runFd: number, token: string, deps: ScrubDeps): null {
  const folder = privateFolder(runFd, true);
  try {
    const fd = openAt(folder, FILE, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      const bytes = Buffer.from(token);
      for (let done = 0; done < bytes.length;) done += writeSync(fd, bytes, done);
    } finally {
      closeSync(fd);
    }
    const rest = { ...deps.env };
    Reflect.deleteProperty(rest, TOKEN_ENV);
    try {
      deps.execve(deps.execPath, [deps.execPath, ...deps.execArgv, ...deps.argv.slice(1)], rest);
    } catch (error) {
      unlinkAt(folder, FILE);
      throw error;
    }
    return null;
  } finally {
    closeQuietly(folder);
  }
}

function readOnce(runFd: number): string {
  const folder = privateFolder(runFd, false);
  try {
    const fd = openAt(folder, FILE, constants.O_RDONLY);
    let text: string;
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 256) {
        throw new Error(`${FILE} is not a private token file`);
      }
      text = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
      unlinkAt(folder, FILE);
    }
    const checked = GatewayToken.safeParse(text);
    if (!checked.success) throw new Error("the parked gateway token is malformed");
    return checked.data;
  } finally {
    closeQuietly(folder);
  }
}
