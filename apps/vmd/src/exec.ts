import { execFile, spawn } from "node:child_process";
import type { Exec, ExecResult } from "./ops.ts";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Where pap's shim wrapper, nerdctl and Kata's tools live, then the system's. */
const CHILD_ENV = Object.freeze({
  PATH: "/opt/pap-vm/bin:/opt/kata/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C",
  /** T20a: buildctl creates its config folder; its default (under root's home) is read-only under the unit's ProtectSystem=strict. */
  DOCKER_CONFIG: "/run/pap-vm/docker-config",
});

/** Splits a stream into lines (`\n` or `\r` ends one); the rest waits for its end. Empty lines are dropped. */
function lineSplitter(emit: (line: string) => void): { push(chunk: string): void; end(): void } {
  let rest = "";
  const flush = (text: string): void => {
    if (text !== "") emit(text);
  };
  return {
    push(chunk) {
      const parts = (rest + chunk).split(/[\r\n]/);
      rest = parts.pop() ?? "";
      parts.forEach(flush);
    },
    end() {
      flush(rest);
      rest = "";
    },
  };
}

/** `spawn` with the same environment, timeout and output cap as `execFile`, telling `onLine` each line as it is printed. */
function streamed(
  program: string,
  args: string[],
  timeout: number,
  onLine: (line: string, stream: "stdout" | "stderr") => void,
  resolve: (result: ExecResult) => void,
): void {
  const child = spawn(program, args, {
    timeout,
    env: { ...CHILD_ENV },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = { stdout: "", stderr: "" };
  let overflow = false;
  const splitters = {
    stdout: lineSplitter((line) => onLine(line, "stdout")),
    stderr: lineSplitter((line) => onLine(line, "stderr")),
  };
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream].setEncoding("utf8");
    child[stream].on("data", (chunk: string) => {
      if (out.stdout.length + out.stderr.length + chunk.length > MAX_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
        return;
      }
      out[stream] += chunk;
      try {
        splitters[stream].push(chunk);
      } catch {
        // A listener that throws never stops the program.
      }
    });
  }
  let done = false;
  const finish = (code: number): void => {
    if (done) return;
    done = true;
    try {
      splitters.stdout.end();
      splitters.stderr.end();
    } catch {
      // see above
    }
    resolve({ code: overflow ? -1 : code, ...out });
  };
  child.on("error", () => finish(-1));
  child.on("close", (code) => finish(code ?? -1));
}

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
      if (options?.onLine !== undefined) {
        streamed(program, args, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.onLine, resolve);
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
