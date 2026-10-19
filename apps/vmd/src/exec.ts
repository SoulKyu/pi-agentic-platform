import { execFile } from "node:child_process";
import type { Exec } from "./ops.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Where pap's shim wrapper, nerdctl and Kata's tools live, then the system's. */
const CHILD_ENV = Object.freeze({
  PATH: "/opt/pap-vm/bin:/opt/kata/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
});

/**
 * The only way pap-vmd starts a program: `execFile`, never a shell, with a fixed environment (pap-vmd's own is not passed
 * on). A non-zero exit, a timeout and a program that cannot start all resolve (code -1 for the last two); nothing rejects.
 */
export function createExec(): Exec {
  return (argv, options) =>
    new Promise((resolve) => {
      const [program, ...args] = argv;
      if (program === undefined) {
        resolve({ code: -1, stdout: "", stderr: "" });
        return;
      }
      execFile(
        program,
        args,
        {
          timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          maxBuffer: MAX_OUTPUT_BYTES,
          encoding: "utf8",
          env: { ...CHILD_ENV },
          shell: false,
        },
        (error, stdout, stderr) => {
          const code = error === null ? 0 : typeof error.code === "number" ? error.code : -1;
          resolve({ code, stdout, stderr });
        },
      );
    });
}
