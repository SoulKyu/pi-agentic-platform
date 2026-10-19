import { spawn as nodeSpawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import type { Writable } from "node:stream";
import { errorClass } from "../bounded.ts";
import type { Redactor } from "../policy/redact.ts";
import {
  runShellProcess,
  type ShellCallOptions,
  type ShellOperations,
  type ShellTimers,
  SYSTEM_TIMERS,
} from "../shell-process.ts";
import { bwrapVmArgv, type VmShellSpec } from "./argv.ts";
import { encodeSeccomp, shellSeccompProgram } from "./seccomp.ts";

/** Commands waiting behind the running one (R27: one at a time per worker); more are refused, never queued without bound. */
const MAX_QUEUED = 32;
/** The seccomp descriptor bwrap reads (`--seccomp 3`): the fourth `stdio` entry. */
const SECCOMP_FD = 3;
const SHELL_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * The agent's shell in its VM: every command is `bwrap … -- /bin/sh -c <command>` with the filter on fd 3 (R2, R18). The
 * environment is a fixed allowlist, never the worker's (it holds the relay key, R13) and never the one Pi passes. One
 * command runs at a time; later calls wait their turn. No fallback: a bwrap that cannot start is a failed command.
 */
export function vmShell(
  spec: VmShellSpec,
  deps: {
    readonly timers?: ShellTimers;
    readonly spawn?: typeof nodeSpawn;
    readonly redact?: () => Redactor;
  } = {},
): ShellOperations {
  const timers = deps.timers ?? SYSTEM_TIMERS;
  const spawn = deps.spawn ?? nodeSpawn;
  const filter = encodeSeccomp(shellSeccompProgram());
  const env = { PATH: SHELL_PATH, HOME: spec.layout.home, LANG: "C.UTF-8", TERM: "dumb" };
  const overlay = `${spec.layout.shellOverlay}/${spec.slot}`;
  let overlayMade = false;
  let tail: Promise<unknown> = Promise.resolve();
  let waiting = 0;

  const afterThen = (after: () => Promise<void>, then: () => void): void =>
    void after().then(then, () => then());

  /** The slot's upper and work folders, 0700, at first use (only an overlay root has them). */
  function makeOverlay(): void {
    if (spec.rootView !== "overlay" || overlayMade) return;
    for (const dir of [`${overlay}/upper`, `${overlay}/work`])
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    overlayMade = true;
  }

  function run(command: string, options: ShellCallOptions): Promise<{ exitCode: number | null }> {
    return runShellProcess(
      () => {
        const argv = bwrapVmArgv(spec, command, SECCOMP_FD);
        makeOverlay();
        // The argument list starts with the binary itself (the first element is `spec.bwrap`).
        const child = spawn(argv[0] ?? spec.bwrap, argv.slice(1), {
          cwd: "/",
          env: { ...env },
          detached: true,
          stdio: ["ignore", "pipe", "pipe", "pipe"],
        });
        const channel = child.stdio[SECCOMP_FD] as Writable | null | undefined;
        // A bwrap that is already gone breaks the pipe: the close event reports the command's failure.
        channel?.on("error", (error) => {
          process.stderr.write(`pi-host: vm shell filter pipe failed (${errorClass(error)})\n`);
        });
        channel?.end(filter);
        return child;
      },
      options,
      { timers, ...(deps.redact ? { redact: deps.redact } : {}) },
      async () => {},
      afterThen,
    );
  }

  return {
    exec(command, _cwd, options) {
      if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
      if (waiting >= MAX_QUEUED) return Promise.reject(new Error("vm shell: too many queued commands"));
      waiting++;
      const turn = tail.then(() => {
        waiting--;
        // Stop while it waited: it never starts.
        if (options.signal?.aborted) throw new Error("aborted");
        return run(command, options);
      });
      tail = turn.catch(() => undefined);
      return turn;
    },
  };
}
