import { rmdirSync, rmSync } from "node:fs";
import { lookup } from "node:dns/promises";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import type { EgressStatus } from "@pap/contracts";
import { EGRESS_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import { blockedAddress } from "../../kernel/net/address.ts";
import type { EgressScope } from "./allow.ts";
import { writeForwarder } from "./forwarder.ts";
import { type CommandListener, createProxy } from "./proxy.ts";
import { probePython } from "./python-probe.ts";
import type { CommandReport } from "./report.ts";
import {
  bootClean,
  chooseRoot,
  dropFolder,
  prepareRoot,
  rootReasonOf,
  sessionFolder,
} from "./runtime-dir.ts";

export { writeForwarder } from "./forwarder.ts";
export { createProxy, type CommandListener, type Limits, type ProxyDeps } from "./proxy.ts";
export type { EgressScope } from "./allow.ts";
export type { CommandReport } from "./report.ts";

export interface EgressDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly papHome: string;
  /** `$XDG_RUNTIME_DIR`, read by the composition: this module reads no environment variable. */
  readonly runtimeDir: string | undefined;
  /** Test seam for the interpreter probe. */
  readonly probe?: () => Promise<EgressStatus>;
}

interface Session {
  readonly dir: string;
  readonly transient: boolean;
  next: number;
  readonly commands: Map<string, Promise<CommandListener>>;
}

/** A report that is missing reads as truncated, never as clean: the caller taints (M11R233). */
const MISSING: CommandReport = { hosts: [], truncated: true, up: 0, down: 0 };
const UNKNOWN: EgressStatus = { usable: false, python: null, reason: "no_python" };

/** The egress proxy of the daemon: one listener per command, in a folder per agent session (M11R232, M11R234). */
export function createEgress(deps: EgressDeps) {
  const { clock, logger } = deps;
  const proxy = createProxy({
    clock,
    logger,
    resolve: async (host) => (await lookup(host, { all: true })).map((answer) => answer.address),
    denies: blockedAddress,
    connect: (ip, port) => connect({ host: ip, port }),
  });
  // `/run/user/1000/` and `/run/user/1000` are one folder: the root is judged against the runtime folder without the slash.
  const runtimeDir =
    deps.runtimeDir === undefined || deps.runtimeDir === "" ? undefined : resolve(deps.runtimeDir);
  const root = chooseRoot({ runtimeDir, papHome: deps.papHome });
  const underRuntime = runtimeDir !== undefined && root?.startsWith(`${runtimeDir}/`) === true;
  const base = underRuntime ? runtimeDir : deps.papHome;
  const sessions = new Map<string, Session>();
  let sessionCounter = 0;
  let python: EgressStatus = UNKNOWN;
  let rootUsable = false;
  let forwarderPath: string | null = null;
  let booted: Promise<void> = Promise.resolve();
  let shutDown = false;

  const keyOf = (scope: EgressScope): string => scope.sessionId ?? `pre:${scope.agentId}`;
  const status = (): EgressStatus =>
    python.usable && !rootUsable ? { ...python, usable: false, reason: "socket_path" } : python;
  const probe = async (): Promise<void> => {
    try {
      python = await (deps.probe?.() ?? probePython({ clock }));
    } catch (error) {
      // A probe that throws is an interpreter that cannot be used: the gate then answers sandbox_unavailable.
      logger.warn("egress_probe_failed", { err: error });
      python = UNKNOWN;
    }
    if (root === null) python = { ...python, usable: false, reason: "socket_path" };
  };

  /** Makes the root, removes what a dead daemon left and writes the forwarder; says why when it cannot. */
  function prepare(): void {
    if (root === null || shutDown) return;
    try {
      prepareRoot(root, base);
      bootClean(root, logger);
      forwarderPath = writeForwarder(root);
      rootUsable = true;
    } catch (error) {
      rootUsable = false;
      logger.warn("egress_root_unusable", { err: error, reason: rootReasonOf(error) });
    }
  }

  /** The boot work; its synchronous part (root, cleanup, forwarder) has run when the call returns. */
  async function boot(): Promise<void> {
    prepare();
    await probe();
    logger.info("egress_status", { ...status() });
  }

  async function closeSession(key: string): Promise<void> {
    const session = sessions.get(key);
    if (session === undefined || root === null) return;
    sessions.delete(key);
    await Promise.all(
      [...session.commands.values()].map((open) => open.then((listener) => listener.close())),
    );
    dropFolder(root, session.dir);
  }

  return {
    status,
    /** Makes the root again when the boot could not, then probes the interpreter again ("Check again"). */
    async recheck(): Promise<void> {
      if (!rootUsable) prepare();
      await probe();
    },
    /** Settles when the boot (cleanup, forwarder, probe) has run: a launch gate waits for it before it reads `status()`. */
    ready: (): Promise<void> => booted,
    get forwarderPath(): string | null {
      return forwarderPath;
    },
    /** At boot: makes the root, removes what a dead daemon left, writes the forwarder, probes the interpreter. */
    bootClean(): Promise<void> {
      booted = boot();
      return booted;
    },
    async openCommand(
      scope: EgressScope,
    ): Promise<{ id: string; socket: string } | { reason: "unavailable" | "limit" }> {
      if (root === null || !status().usable) return { reason: "unavailable" };
      const key = keyOf(scope);
      let session = sessions.get(key);
      if (session === undefined) {
        try {
          session = {
            dir: (sessionCounter++).toString(36),
            transient: scope.sessionId === null,
            next: 0,
            commands: new Map(),
          };
          sessionFolder(root, session.dir);
        } catch (error) {
          logger.warn("egress_session_failed", { err: error });
          return { reason: "unavailable" };
        }
        sessions.set(key, session);
      }
      if (session.commands.size >= EGRESS_LIMITS.commandsPerSession) return { reason: "limit" };
      const id = (session.next++).toString(36);
      const socket = `${root}/${session.dir}/${id}.s`;
      const opening = proxy.listen(socket, scope);
      session.commands.set(id, opening);
      try {
        await opening;
      } catch (error) {
        session.commands.delete(id);
        logger.warn("egress_listen_failed", { err: error });
        return { reason: "unavailable" };
      }
      return { id, socket };
    },
    /** The command's report; an unknown or already closed command answers a truncated one. `by` is the scope, or the session id. */
    async closeCommand(by: EgressScope | string, id: string): Promise<CommandReport> {
      const key = typeof by === "string" ? by : keyOf(by);
      const session = sessions.get(key);
      const opening = session?.commands.get(id);
      if (session === undefined || opening === undefined) return { ...MISSING };
      session.commands.delete(id);
      const report = await (await opening).close();
      if (session.transient && session.commands.size === 0) await closeSession(key);
      return report;
    },
    /** The worker exited: closes the session's commands and removes its folder. */
    dropSession: closeSession,
    /**
     * The daemon stops: closes every session, and removes this daemon's folders under the runtime folder (a tmpfs that no
     * one else empties), the forwarder included. A root under PAP_HOME stays: the next boot cleans it.
     */
    async shutdown(): Promise<void> {
      // First: nothing (a recheck, a late boot) makes the root again while the sessions close.
      shutDown = true;
      for (const key of [...sessions.keys()]) await closeSession(key);
      if (root === null || !underRuntime) return;
      rootUsable = false;
      forwarderPath = null;
      try {
        rmSync(root, { recursive: true, force: true });
        // Only this daemon's `pap/<key>`: the shared `pap` folder may be another daemon's `prepareRoot` right now.
        rmdirSync(dirname(root));
      } catch (error) {
        logger.warn("egress_shutdown_failed", { err: error });
      }
    },
  };
}
export type Egress = ReturnType<typeof createEgress>;
/** What the sessions module uses of the proxy (M11R243): the status, the forwarder file, and the per-command sockets. */
export type EgressPort = Pick<
  Egress,
  | "ready"
  | "recheck"
  | "status"
  | "forwarderPath"
  | "openCommand"
  | "closeCommand"
  | "dropSession"
  | "shutdown"
>;

/** The real proxy (M11R244), booted now: its synchronous part (root, cleanup, forwarder) runs here, the probe finishes in the background. */
export function bootEgress(deps: EgressDeps): Egress {
  const egress = createEgress(deps);
  void egress.bootClean();
  return egress;
}
