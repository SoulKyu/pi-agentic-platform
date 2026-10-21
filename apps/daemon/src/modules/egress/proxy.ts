import { chmodSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { EGRESS_LIMITS } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { EgressScope } from "./allow.ts";
import { createJudge } from "./judge.ts";
import { createCores, type Limits } from "./proxy-core.ts";
import { type CommandReport, loggedHosts } from "./report.ts";

export type { Limits } from "./proxy-core.ts";

/**
 * Everything the proxy reaches the world through. `resolve`, `denies` and `connect` are required and have no default:
 * `index.ts` passes the system resolver, `blockedStrict` and `net.connect`; only tests pass anything else (M11R244).
 */
export interface ProxyDeps {
  readonly clock: Clock;
  readonly logger: Logger;
  resolve(host: string): Promise<readonly string[]>;
  denies(ip: string): boolean;
  connect(ip: string, port: number): Socket;
  readonly limits?: Limits;
}

export interface CommandListener {
  readonly path: string;
  readonly server: Server;
  /** Stops accepting, destroys every connection, removes the socket, answers the report. Safe to call twice. */
  close(): Promise<CommandReport>;
}

export function createProxy(deps: ProxyDeps) {
  const { clock, logger } = deps;
  const limits: Limits = deps.limits ?? EGRESS_LIMITS;
  const cores = createCores({ clock, logger, connect: (ip, port) => deps.connect(ip, port), limits });
  const judge = createJudge({
    clock,
    logger,
    resolve: (host) => deps.resolve(host),
    denies: (ip) => deps.denies(ip),
    resolveMs: limits.resolveMs,
  });

  async function listen(path: string, scope: EgressScope): Promise<CommandListener> {
    let finished: Promise<CommandReport> | null = null;
    const server = createServer({ maxHeaderSize: limits.headBytes, headersTimeout: 0, requestTimeout: 0 });
    const lane = {}; // names this command to the lookup semaphore
    const core = cores.create({
      scope,
      decide: (kind, host, port) => judge.decide(scope, lane, kind, host, port),
    });
    core.attach(server);

    const close = (): Promise<CommandReport> =>
      (finished ??= (async () => {
        core.close();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        rmSync(path, { force: true });
        const snapshot = core.snapshot();
        const hosts = loggedHosts(snapshot, scope, limits.logHosts);
        logger.info("egress_command", {
          sessionId: scope.sessionId,
          agentId: scope.agentId,
          ...core.counts(),
          up: snapshot.up,
          down: snapshot.down,
          hosts,
        });
        return snapshot;
      })());

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(path, 0o600);
    } catch (error) {
      await close();
      throw error;
    }
    return { path, server, close };
  }

  return { listen };
}
