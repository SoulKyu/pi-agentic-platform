import type { AgentsVmSeams } from "./compose-agents-vm.ts";
import type { Fetcher } from "./compose-fonts.ts";
import type { PushSeams } from "./compose-push.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Logger } from "./kernel/logger.ts";
import type { WorkerExit } from "./kernel/supervisor/exit.ts";
import type { probeScopes } from "./kernel/supervisor/scope.ts";

export interface DaemonHandle {
  readonly url: string;
  readonly port: number;
  /** The one-time owner setup address while no owner exists; in `--dev` it carries the Vite dev origin (R31). */
  readonly setupUrl: string | null;
  readonly inspect: {
    workerPid(sessionId: string): number | undefined;
    workerRssMb(sessionId: string): number | null;
    /** Tests: what the runs registry says the session cost, its subagents included (M11R141). */
    sessionCost(sessionId: string): number | null;
  };
  /** Idempotent. Workers go first (R104), then the sockets, the receipt purge, the database and the instance lock. */
  stop(): Promise<void>;
  /** A stop was given up: SIGKILLs every worker scope of this home, synchronously and bounded. Never throws. */
  killScopes(): void;
}

export interface DaemonDeps {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly env?: NodeJS.ProcessEnv;
  /**
   * The HTTP server raised an error after it started: the caller stops the daemon and exits non-zero (R75). Called
   * once, however many errors follow: a second call would look like a second signal and cut the shutdown short (R115).
   */
  readonly onFatal?: (reason: "server_error") => void;
  /**
   * Where the one-time setup address goes. Defaults to `logger.info("setup_url")`; `pap serve` prints it whatever
   * PAP_LOG_LEVEL is, because without it nobody can create the owner (R117).
   */
  readonly announceSetupUrl?: (fields: { readonly url: string; readonly hint: string }) => void;
  /** A worker exited: its session and the end of what it printed (at most the supervisor's 8 KiB tail). */
  readonly onWorkerExit?: (sessionId: string, info: { exit: WorkerExit; outputTail: string }) => void;
  /** Tests only: replaces the boot probe of the worker scopes. */
  readonly probeScopes?: typeof probeScopes;
  readonly push?: PushSeams; // tests only: replaces the transport side
  readonly fontsFetcher?: Fetcher; // tests only: replaces the Google Fonts fetcher
  readonly agentsVm?: AgentsVmSeams; // the guest seam, T9b's mirrors (J1)
}
