import { spawn as nodeSpawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";
import { constants as osConstants } from "node:os";
import { bwrapArgv, type EgressReport, type SandboxSpec } from "@pap/contracts";
import { errorClass } from "./bounded.ts";
import { clipUnits, MAX_ID_LENGTH } from "./policy/trail.ts";
import type { EgressGrant } from "./egress-client.ts";
import { NO_PROXY_LINE, refusedLine } from "./egress-line.ts";
import type { Redactor } from "./policy/redact.ts";
import { addStreamCount, createStreamRedactor } from "./redact-stream.ts";

/** Pi's `BashOperations` shape (`@earendil-works/pi-coding-agent`), repeated so this file has no SDK import. */
export interface ShellOperations {
  exec(
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    },
  ): Promise<{ exitCode: number | null }>;
}

/** The proxy's side of a networked command: what `createEgressClient` offers the shell (M11R232). */
export interface ShellEgress {
  open(): Promise<EgressGrant | null>;
  close(id: string): Promise<EgressReport | null>;
  keep(toolCallId: string, report: EgressReport | null): void;
}

/** The id of the tool call whose `execute` is running: Pi passes none to `operations.exec` (set by `createSandboxTool`). */
export const toolCall = new AsyncLocalStorage<string>();

/** The worker's timer seam (tests drive the tool timeout without sleeping). */
export interface ShellTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const SYSTEM_TIMERS: ShellTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};
/** What `setTimeout` takes: a longer delay fires at once (Node's overflow), which would kill a command the model gave a day. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const killGroup = (pid: number | undefined): void => {
  // Never `process.kill(-0)` or `-1`: those are this process group and every process the user owns.
  if (pid === undefined || pid <= 1) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // already gone
  }
};

/** A real folder: not a link, and no link above it (`realpath` is the path itself). bwrap follows a link on the host, so one planted in place of the home would bind another folder. */
function isRealFolder(path: string): boolean {
  try {
    return lstatSync(path).isDirectory() && realpathSync(path) === path;
  } catch {
    return false;
  }
}

/**
 * The spec as bwrap can take it, or a refusal (a daemon bug or a planted link, never a fallback): the home and the writable
 * folder are real folders; a hidden folder that does not exist is dropped (nothing is there to hide, and bwrap cannot
 * mount on the read-only root), one that is a link or a file is refused (bwrap fails on it, or the link would be followed).
 */
function checked(spec: SandboxSpec): SandboxSpec {
  if (!isRealFolder(spec.home))
    throw new Error("sandbox: the home is not a real folder (missing, a file or behind a symbolic link)");
  if (spec.writable !== null && !isRealFolder(spec.writable))
    throw new Error(
      "sandbox: the writable folder is not a real folder (missing, a file or behind a symbolic link)",
    );
  const hide = spec.hide.filter((path) => {
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code === "ENOENT" || code === "ENOTDIR") return false;
      throw new Error("sandbox: a hidden folder cannot be looked at", { cause: error });
    }
    if (!stat.isDirectory()) throw new Error("sandbox: a hidden folder is a symbolic link or a file");
    return true;
  });
  return { ...spec, hide };
}

/**
 * Every command of an agent's `bash` runs as `bwrap … -- /bin/sh -c <command>` (ADR 0048). The environment is `envFor`'s
 * (`sandboxEnv` plus, from Task 18, a one-use value the command names): the `env` Pi passes (the worker's own, provider
 * keys included) is ignored. The cwd is the spec's (`writable ?? home`), whatever the call says. One process group per
 * command: Stop, the timeout and the worker's shutdown kill it whole, and `--unshare-pid` takes every process of the
 * sandbox with it. No fallback: a bwrap that cannot start is a failed command, never an unsandboxed one.
 */
export function sandboxedShell(
  spec: SandboxSpec,
  envFor: (command: string) => Readonly<Record<string, string>>,
  deps: {
    readonly timers?: ShellTimers;
    readonly spawn?: typeof nodeSpawn;
    readonly egress?: ShellEgress;
    /** The worker's secrets: the output Pi receives is redacted as it streams, because Pi writes it to a file first. */
    readonly redact?: () => Redactor;
  } = {},
): ShellOperations {
  const timers = deps.timers ?? SYSTEM_TIMERS;
  const spawn = deps.spawn ?? nodeSpawn;

  /** Runs `after`, then `then`; a failing `after` is logged by class and never leaves the call unsettled. */
  const afterThen = (after: () => Promise<void>, then: () => void): void =>
    void after().then(then, (error: unknown) => {
      process.stderr.write(`pi-host: egress close failed (${errorClass(error)})\n`);
      then();
    });

  /** `after` runs once the child is gone and before the call settles: the egress close and the lines after the output. */
  function run(
    shape: SandboxSpec,
    socket: string | undefined,
    command: string,
    { onData, signal, timeout }: Parameters<ShellOperations["exec"]>[2],
    after: () => Promise<void>,
  ): Promise<{ exitCode: number | null }> {
    return new Promise((resolve, reject) => {
      let child: ReturnType<typeof nodeSpawn>;
      try {
        if (
          timeout !== undefined &&
          !(Number.isFinite(timeout) && timeout > 0 && timeout * 1000 <= MAX_TIMER_MS)
        )
          throw new Error("Invalid timeout: must be a finite number of seconds");
        const safe = checked(shape);
        child = spawn(safe.bwrap, bwrapArgv(safe, command, socket), {
          cwd: safe.writable ?? safe.home,
          env: { ...envFor(command) },
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        // Nothing started: a granted socket is still given back.
        afterThen(after, () => reject(error));
        return;
      }
      const callId = toolCall.getStore();
      // One stream per pipe: each has its own decoder, and a multi-byte character never spans the two.
      const streams = deps.redact
        ? [createStreamRedactor(deps.redact), createStreamRedactor(deps.redact)]
        : null;
      const hand = (index: 0 | 1) => (data: Buffer) => {
        const safe = streams ? (streams[index]?.push(data) ?? data) : data;
        if (safe.length > 0) onData(safe);
      };
      let timedOut = false;
      const timer =
        timeout !== undefined
          ? timers.setTimeout(() => {
              timedOut = true;
              killGroup(child.pid);
            }, timeout * 1000)
          : undefined;
      const onAbort = () => killGroup(child.pid);
      signal?.addEventListener("abort", onAbort, { once: true });
      // Aborted while the proxy was being asked: the listener above would never hear it.
      if (signal?.aborted) onAbort();
      const finish = () => {
        if (timer !== undefined) timers.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        for (const stream of streams ?? []) {
          const rest = stream.flush();
          if (rest.length > 0) onData(rest);
        }
        if (streams && callId !== undefined)
          addStreamCount(
            clipUnits(callId, MAX_ID_LENGTH),
            streams.reduce((sum, stream) => sum + stream.count(), 0),
          );
      };
      child.stdout?.on("data", hand(0));
      child.stderr?.on("data", hand(1));
      // An error and a close can both come for one child: the first ends the call, `after` runs once.
      let ended = false;
      child.once("error", (error) => {
        if (ended) return;
        ended = true;
        finish();
        afterThen(after, () => reject(error));
      });
      child.once("close", (code, signalName) => {
        if (ended) return;
        ended = true;
        finish();
        afterThen(after, () => {
          if (signal?.aborted) return reject(new Error("aborted"));
          if (timedOut) return reject(new Error(`timeout:${timeout}`));
          resolve({
            exitCode: code ?? (signalName ? 128 + (osConstants.signals[signalName] ?? 0) : 1),
          });
        });
      });
    });
  }

  /** A networked spec (M11R230): the proxy's socket for this call, or no network at all and a line saying so. */
  async function networked(command: string, options: Parameters<ShellOperations["exec"]>[2]) {
    const toolCallId = toolCall.getStore();
    const grant = toolCallId !== undefined && deps.egress ? await deps.egress.open() : null;
    // Output is followed by a line on its own: a newline first when the command's last byte was not one.
    let endsLine = true;
    const onData = (data: Buffer) => {
      if (data.length > 0) endsLine = data[data.length - 1] === 10;
      options.onData(data);
    };
    // The line holds a host the agent chose, so it is redacted like the output it follows (Pi's full-output file gets it too).
    const say = (line: string | null) => {
      if (line === null) return;
      const safe = deps.redact ? deps.redact().text(line).text : line;
      options.onData(Buffer.from(`${endsLine ? "" : "\n"}${safe}\n`));
    };
    if (grant === null || toolCallId === undefined || deps.egress === undefined) {
      return run(
        { ...spec, network: false, egress: null },
        undefined,
        command,
        { ...options, onData },
        async () => say(NO_PROXY_LINE),
      );
    }
    const { egress } = deps;
    return run(spec, grant.socket, command, { ...options, onData }, async () => {
      const report = await egress.close(grant.id);
      egress.keep(clipUnits(toolCallId, MAX_ID_LENGTH), report);
      say(refusedLine(report, spec.view));
    });
  }

  return {
    exec(command, _cwd, options) {
      if (options.signal?.aborted) return Promise.reject(new Error("aborted"));
      if (spec.egress === null) return run(spec, undefined, command, options, async () => {});
      return networked(command, options);
    },
  };
}
