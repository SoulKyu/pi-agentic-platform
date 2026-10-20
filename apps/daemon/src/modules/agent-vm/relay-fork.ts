import { fork } from "node:child_process";
import { tmpdir } from "node:os";
import { AGENT_NET, type EnvSource, NETWORK_ENV, unattendedEnv } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { scrubKnownSecrets } from "../audit/index.ts";
import type { RelayChild } from "./relay-link.ts";

/** Lines of the relay's stderr the daemon logs per minute; the rest is counted. */
const LOG_LINES_PER_MINUTE = 30;
const LOG_LINE_CHARS = 300;
/** A line that long without a newline is cut here and logged as a line (its start is not kept, so no value half-hides). */
const PARTIAL_MAX_CHARS = 16_384;

/**
 * Where `pap-relay` listens (R34, AVM-P10): the bridge's host address under Kata, an ephemeral loopback port under the
 * process backend. Never a wildcard: the child itself refuses one and exits.
 */
export const relayListenOf = (loopback: boolean): string =>
  loopback ? "127.0.0.1:0" : `${AGENT_NET.host}:${AGENT_NET.relayPort}`;

/**
 * The relay's environment (AVM-P10, T12): Pi's agent folder, where it reads the owner's credentials through Pi's auth storage,
 * and the unattended-child allowlist (who and where the owner is, proxies and CA bundles); nothing else. A scripted provider
 * test adds the switch that lets the relay use a loopback upstream. Never `NODE_TLS_REJECT_UNAUTHORIZED` or any provider key.
 */
export function relayEnv(
  base: EnvSource,
  agentDir: string,
  testProviderScript: string | null,
): Record<string, string> {
  return unattendedEnv(base, {
    keep: [...NETWORK_ENV],
    set: {
      PI_CODING_AGENT_DIR: agentDir,
      ...(testProviderScript === null ? {} : { PAP_TEST_PROVIDER_SCRIPT: testProviderScript }),
    },
  });
}

export interface RelayForkOptions {
  /** `pap-relay`'s main (the worker's neighbour: `<dist or src>/relay/main`). */
  readonly entry: string;
  readonly execArgv: readonly string[];
  readonly listen: string;
  readonly env: Record<string, string>;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Masks the owner's values in a line before it is logged (T15b); default: only the well-known formats are scrubbed. */
  readonly redact?: (line: string) => Promise<string>;
}

/** Starts the relay child on an IPC channel; what it prints is logged (clipped and counted), never parsed. */
export function forkRelay(options: RelayForkOptions): RelayChild {
  const { clock, logger } = options;
  const child = fork(options.entry, ["--listen", options.listen], {
    cwd: tmpdir(),
    env: options.env,
    execArgv: [...options.execArgv],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
  });
  let windowStart = clock.now();
  let logged = 0;
  let held = 0;
  let tail: Promise<unknown> = Promise.resolve();
  const redact = options.redact ?? (async (text: string) => scrubKnownSecrets(text).text);
  const line = (raw: string): void => {
    if (clock.now() - windowStart >= 60_000) {
      if (held > 0) logger.warn("relay_log_held", { lines: held });
      windowStart = clock.now();
      logged = 0;
      held = 0;
    }
    if (logged >= LOG_LINES_PER_MINUTE) {
      held++;
      return;
    }
    logged++;
    // Masked before it is clipped, so a clip never leaves half of a value; one at a time, so the log keeps its order.
    tail = tail
      .then(() => redact(raw))
      .catch(() => "[line withheld]")
      .then((text) => logger.warn("relay_log", { line: text.slice(0, LOG_LINE_CHARS) }));
  };
  let partial = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    partial += chunk.toString("utf8");
    const parts = partial.split("\n");
    partial = parts.pop() ?? "";
    if (partial.length > PARTIAL_MAX_CHARS) {
      parts.push(partial);
      partial = "";
    }
    for (const text of parts) if (text !== "") line(text);
  });
  child.stderr?.on("error", () => {});
  child.stdout?.resume();
  child.stdout?.on("error", () => {});
  return child;
}
