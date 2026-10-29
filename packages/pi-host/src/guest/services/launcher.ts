import { spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import { errorClass } from "../../bounded.ts";
import { SERVICE_SECCOMP_FD, serviceEnv, serviceLaunch } from "./launch.ts";
import type { Launcher } from "./supervisor.ts";

/**
 * The real launcher: the service runs in the session shell's bwrap (`serviceLaunch`), spawned exactly as `vmShell` spawns a
 * command, with the filter written to its fourth descriptor. The stop signals go to this outer bwrap only.
 */
export function bwrapLauncher(log: (line: string) => void): Launcher {
  return {
    netnsFrom: "child",
    start(input) {
      const launch = serviceLaunch(input);
      const child = spawn(launch.argv[0] as string, launch.argv.slice(1), {
        cwd: "/",
        env: { ...launch.env },
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "pipe"],
      });
      const channel = child.stdio[SERVICE_SECCOMP_FD] as Writable | null | undefined;
      // A bwrap that is already gone breaks the pipe: its exit reports the failure.
      channel?.on("error", (error) => log(`service filter pipe failed (${errorClass(error)})`));
      channel?.end(launch.filter);
      return child;
    },
    kill: (child, signal) => void child.kill(signal),
  };
}

/**
 * The process backend's launcher (tests only, UX2-R20): `/bin/sh -c` in the project folder or the home, no bwrap, in its own
 * process group, which the stop signals reach. Never chosen in a VM.
 */
export function plainLauncher(): Launcher {
  return {
    netnsFrom: "root",
    start(input) {
      return spawn("/bin/sh", ["-c", input.command], {
        cwd: input.layout.project ?? input.layout.home,
        env: { ...serviceEnv(input) },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    },
    kill(child: ChildProcess, signal) {
      if (child.pid !== undefined && child.pid > 1) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // the group is gone or not ours: the child itself is the fallback
        }
      }
      child.kill(signal);
    },
  };
}
