import { execFile, spawnSync } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { Exec } from "./supervisor/scope.ts";

/** The first executable file named `command` on PATH, or null. No shell is involved. */
export function whichOnPath(command: string, env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, command);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable: the next PATH entry is tried; a miss everywhere returns null.
    }
  }
  return null;
}

/** Runs a program without a shell; a timeout or a spawn failure rejects. Output is capped at 64 KiB. */
export const execFileText: Exec = (file, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024, encoding: "utf8" },
      (error, stdout) => {
        if (error && typeof (error as NodeJS.ErrnoException).code === "string") return reject(error);
        resolve({ code: error ? ((error as { code?: number }).code ?? 1) : 0, stdout });
      },
    );
  });

/** Runs a program without a shell and waits, at most `timeoutMs`: the exit code, or null when it could not run in time. */
export function execFileCode(file: string, args: readonly string[], timeoutMs: number): number | null {
  const result = spawnSync(file, [...args], { timeout: timeoutMs, stdio: "ignore" });
  return result.error ? null : result.status;
}
