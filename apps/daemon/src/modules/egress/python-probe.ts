import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { type EgressStatus, SYSTEM_FOLDERS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { trustedBinary, type TrustOps } from "../../kernel/sandbox/probe.ts";

export const PYTHON_CANDIDATES = ["/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3"] as const;
const PYTHON_TIMEOUT_MS = 5_000;
const OUTPUT_CHARS = 256;

export interface PythonProbeDeps {
  readonly clock: Pick<Clock, "setTimeout" | "clearTimeout">;
  /** Test seams: the file system reads of `trustedBinary`, and `child_process.spawn`. */
  readonly ops?: TrustOps;
  readonly spawn?: typeof nodeSpawn;
}

const insideSystemView = (path: string): boolean =>
  SYSTEM_FOLDERS.some((folder) => path.startsWith(`${folder}/`));

/** Runs `python -I -S -c "print('<nonce>')"` once; true when it answered the nonce within 5 s. */
function runs(python: string, deps: PythonProbeDeps): Promise<boolean> {
  const nonce = randomBytes(16).toString("hex");
  return new Promise<boolean>((resolve) => {
    let output = "";
    let done = false;
    const finish = (ok: boolean, kill: boolean): void => {
      if (done) return;
      done = true;
      deps.clock.clearTimeout(timer);
      if (kill) child.kill("SIGKILL");
      resolve(ok);
    };
    const child = (deps.spawn ?? nodeSpawn)(python, ["-I", "-S", "-c", `print('${nonce}')`], {
      env: {},
      stdio: ["ignore", "pipe", "ignore"],
    });
    const timer = deps.clock.setTimeout(() => finish(false, true), PYTHON_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      if (output.length < OUTPUT_CHARS) output += chunk.toString("utf8").slice(0, OUTPUT_CHARS);
    });
    child.once("error", () => finish(false, false));
    child.once("close", () => finish(output.trim() === nonce, false));
  });
}

/**
 * The forwarder's interpreter (M11R242): the first of three system paths whose real path passes the sandbox probe's rule
 * (root-owned, no group- or world-writable folder above it) and lies inside `SYSTEM_FOLDERS`, so the `system` view of an
 * isolated task sees it, and that answers a nonce. A user-owned `python3` is never run.
 */
export async function probePython(deps: PythonProbeDeps): Promise<EgressStatus> {
  const ops: TrustOps = deps.ops ?? {
    realpath: (path) => realpathSync(path),
    stat: (path) => statSync(path),
  };
  let reason: "no_python" | "unsafe_path" = "no_python";
  for (const candidate of PYTHON_CANDIDATES) {
    try {
      ops.realpath(candidate);
    } catch {
      continue; // not there
    }
    const real = trustedBinary(candidate, ops);
    if (real === null || !insideSystemView(real)) {
      reason = "unsafe_path";
      continue;
    }
    if (await runs(real, deps)) return { usable: true, python: real, reason: null };
  }
  return { usable: false, python: null, reason };
}
