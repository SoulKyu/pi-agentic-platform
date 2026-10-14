import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Hono } from "hono";
import type { Caller } from "@pap/contracts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { BoundaryConfig } from "./kernel/fs/boundary.ts";
import { createDenySet, type DenySources } from "./kernel/fs/deny-set.ts";
import { httpCaller } from "./kernel/http/caller.ts";
import { loadNodePty } from "./kernel/pty/load.ts";
import { guardFilters } from "./kernel/git/filters.ts";
import { createGitRunner } from "./kernel/git/runner.ts";
import type { Logger } from "./kernel/logger.ts";
import type { WorkerScopes } from "./kernel/supervisor/scope.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import { type AttachmentsPort, createFilesModule, type FilesRpc } from "./modules/files/index.ts";
import { createTerminalModule, type TerminalRpc } from "./modules/terminal/index.ts";
import { createVcsModule, type VcsRpc } from "./modules/vcs/index.ts";

/**
 * The path as typed and as it resolves (a link on either side cannot hide it). A path that does not exist yet is resolved
 * through its nearest existing parent (`realpath(parent)` plus the missing segments): a file created there later, under a
 * linked `~`, is judged under the real spelling too. The resolution is made once, at boot.
 */
function spellings(path: string): string[] {
  const missing: string[] = [];
  let parent = path;
  for (;;) {
    try {
      return [...new Set([path, join(realpathSync(parent), ...missing)])];
    } catch (error) {
      const up = dirname(parent);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || up === parent) return [path];
      missing.unshift(basename(parent));
      parent = up;
    }
  }
}

/** `BoundaryConfig`, built once at boot from the configuration and the environment (M8R29): the judge never reads either. */
export function boundaryConfigOf(config: Config, env: NodeJS.ProcessEnv): BoundaryConfig {
  const runtime = env.XDG_RUNTIME_DIR;
  return {
    papHome: spellings(config.home),
    agentDir: spellings(config.piAgentDir),
    home: spellings(config.userHome),
    papHomeOpen: [],
    runtimeDirs: runtime !== undefined && runtime.startsWith("/") ? spellings(runtime) : [],
  };
}

const PI_PRIVATE_FILES = ["auth.json", "models.json", "mcp.json", "trust.json", "settings.json"];
const PAP_PRIVATE_FILES = ["state.db", "state.db-wal", "state.db-shm", "pap.lock"];
const PAP_PRIVATE_FOLDERS = ["secrets", "backups", "exports", "fork-tmp"];
/** The owner's usual secret stores (MC10): a hard link to one of their files, made inside a project, is refused. */
const OWNER_SECRET_FILES = [join(".docker", "config.json"), ".netrc", ".git-credentials"];
const OWNER_SECRET_FOLDERS = [".ssh", ".gnupg", ".aws", join(".config", "gh"), ".kube"];

/**
 * `$PAP_HOME/attachments` is the owner's own uploads, written by pap: not private, and skipped by the deny walk so that
 * churn in it never fills the remembered keys. The path judge still refuses it (it is under `$PAP_HOME`, not in `papHomeOpen`).
 */
const ATTACHMENTS = "attachments";

const under = (bases: readonly string[], names: readonly string[]): string[] =>
  bases.flatMap((base) => names.map((name) => join(base, name)));

/** M8R103, MC8 I3, MC10: what the deny set knows as private. `$PAP_HOME` is walked whole; the named entries stay in addition. */
export function denySourcesOf(boundary: BoundaryConfig): DenySources {
  return {
    files: [
      ...under(boundary.agentDir, PI_PRIVATE_FILES),
      ...under(boundary.papHome, PAP_PRIVATE_FILES),
      ...under(boundary.home, OWNER_SECRET_FILES),
    ],
    folders: [
      ...under(boundary.agentDir, ["sessions"]),
      ...under(boundary.papHome, PAP_PRIVATE_FOLDERS),
      ...boundary.papHome,
      ...under(boundary.home, OWNER_SECRET_FOLDERS),
    ],
    skip: [...boundary.papHomeOpen, ATTACHMENTS].flatMap((open) =>
      boundary.papHome.map((home) => join(home, open)),
    ),
  };
}

export interface WorkspaceDeps {
  /** The caller's project roots (M8R15). */
  roots(ownerId: string): readonly string[];
  readonly config: Config;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly env: NodeJS.ProcessEnv;
  /** The vcs and terminal modules register their streams here (Tasks 9, 12). */
  readonly hub: StreamHub;
  /** The database is read-only (a newer pap wrote it): the modules that write refuse (Task 6a). */
  readonly readOnly: boolean;
  /** Each terminal runs in a scope of its own when there are scopes (M8R54). */
  readonly scopes: Pick<WorkerScopes, "next">;
}

export interface WorkspaceModules {
  readonly rpc: FilesRpc & VcsRpc & TerminalRpc;
  /** Claims of pending uploads per session (Task 8's prompt path). */
  readonly attachments: AttachmentsPort;
  /** The HTTP routes of the modules; they are cookie-only (M8R31), so they take the browser-session check. */
  mount(app: Hono, authenticateCookieHeader: (header: string | undefined) => Caller | null): void;
  /** Every terminal's kill ladder in parallel, then drops what the modules cache. Idempotent. */
  shutdown(): Promise<void>;
}

/** The M8 modules and what they share: the path boundary's configuration, the one deny set and the git runner (M8R28). */
export function createWorkspaceModules(deps: WorkspaceDeps, workerUmask: number): WorkspaceModules {
  // Probed once so a missing node-pty build is logged at boot; the daemon boots without it (M8R51).
  loadNodePty(deps.logger);
  const boundary = boundaryConfigOf(deps.config, deps.env);
  const deny = createDenySet(denySourcesOf(boundary), deps.clock, undefined, undefined, {
    logger: deps.logger.child({ module: "deny_set" }),
  });
  const git = guardFilters(createGitRunner({ env: deps.env, logger: deps.logger.child({ module: "git" }) }));
  const files = createFilesModule({
    roots: deps.roots,
    boundary,
    deny,
    git,
    clock: deps.clock,
    logger: deps.logger,
    readOnly: deps.readOnly,
    workerUmask,
    attachmentsDir: join(deps.config.home, ATTACHMENTS),
  });
  const vcs = createVcsModule({
    roots: deps.roots,
    boundary,
    deny,
    git,
    hub: deps.hub,
    clock: deps.clock,
    logger: deps.logger,
  });
  const terminal = createTerminalModule({
    roots: deps.roots,
    boundary,
    hub: deps.hub,
    clock: deps.clock,
    logger: deps.logger,
    env: deps.env,
    scopes: deps.scopes,
    workerUmask,
    maxTerminals: deps.config.maxTerminals,
    minFreeMemMb: deps.config.minFreeMemMb,
  });
  // The deny set's first walk starts now, with its deadline: the first file read does not pay for it.
  deny.warm();
  let stopping: Promise<void> | undefined;
  return {
    rpc: { ...files.rpc, ...vcs.rpc, ...terminal.rpc },
    attachments: files.attachments,
    mount: (app, authenticate) => files.mount(app, httpCaller(authenticate)),
    shutdown: () => {
      stopping ??= terminal.shutdown().finally(() => {
        // A throw here must not keep `stop()` from cutting the worker groups.
        for (const [name, stop] of [
          ["vcs", vcs.shutdown],
          ["files", files.shutdown],
        ] as const) {
          try {
            stop();
          } catch (error) {
            deps.logger.error("workspace_shutdown_failed", { module: name, err: error });
          }
        }
      });
      return stopping;
    },
  };
}
