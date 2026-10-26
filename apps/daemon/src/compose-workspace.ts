import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Hono } from "hono";
import type { Caller } from "@pap/contracts";
import type { AgentFilesSource } from "./kernel/agent-path.ts";
import type { Clock } from "./kernel/clock.ts";
import type { BoxControl, BoxOps, BoxTerminals, ProjectBoxSource } from "./kernel/boxes.ts";
import type { IsMember } from "./kernel/box-path.ts";
import type { Config } from "./kernel/config.ts";
import type { BoundaryConfig } from "./kernel/fs/boundary.ts";
import { createDenySet, type DenySet, type DenySources } from "./kernel/fs/deny-set.ts";
import { httpCaller } from "./kernel/http/caller.ts";
import { loadNodePty } from "./kernel/pty/load.ts";
import { guardFilters } from "./kernel/git/filters.ts";
import { createGitRunner, type GitRunner } from "./kernel/git/runner.ts";
import type { Logger } from "./kernel/logger.ts";
import type { WorkerScopes } from "./kernel/supervisor/scope.ts";
import type { ClientPathGate } from "./kernel/ws/client-path-gate.ts";
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
    papHomeOpen: ["worktrees"],
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
  /** The owner's box projects and their guest (boxes B1): a box path goes to the guest, never to this machine. */
  readonly boxes?: () => ProjectBoxSource | undefined;
  readonly boxOps?: () => BoxOps | undefined;
  /** The agents' VMs and their folders (`/agents/<id>`): the explorer reaches them through the guest. */
  readonly agentOps?: () => BoxOps | undefined;
  readonly agents?: () => AgentFilesSource | undefined;
  readonly boxControl?: () => BoxControl | undefined;
  readonly boxTerminals?: () => BoxTerminals | undefined;
  /** Members reach box paths only (M14): the modules refuse a host path before any file-system call. */
  readonly isMember: IsMember;
  readonly gate: ClientPathGate;
}

export interface WorkspaceModules {
  readonly rpc: FilesRpc & VcsRpc & TerminalRpc;
  /** Claims of pending uploads per session (Task 8's prompt path). */
  readonly attachments: AttachmentsPort;
  /** The guarded git runner the modules share (M8R28); the lanes modules use this same one. */
  readonly git: GitRunner;
  /** What lanes read files with: the same boundary, deny set and `$PAP_HOME` as the explorer (M9R22). */
  readonly boundary: BoundaryConfig;
  readonly deny: DenySet;
  readonly home: string;
  /** The transports a push may use (`https:ssh`; `Config.testGitProtocols` in tests): lanes read `file` from it. */
  readonly remoteProtocols: string;
  /** The owner's running terminals in a folder or below: a lane is not archived under a shell (M9R40). */
  runningIn(ownerId: string, folder: string): number;
  /** What a lane script is started with: the terminal scopes, the daemon's environment and the starting umask (M9R27). */
  readonly runtime: {
    readonly scopes: Pick<WorkerScopes, "next">;
    readonly env: NodeJS.ProcessEnv;
    readonly umask: number;
  };
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
  // Temporary git indexes for checkpoints (M9R11): the runner accepts a GIT_INDEX_FILE only inside this folder.
  const indexDir = join(deps.config.home, "tmp", "git-index");
  mkdirSync(indexDir, { recursive: true, mode: 0o700 });
  chmodSync(indexDir, 0o700);
  const git = guardFilters(
    createGitRunner({
      env: deps.env,
      logger: deps.logger.child({ module: "git" }),
      indexDir,
      remoteProtocols: deps.config.testGitProtocols ?? "https:ssh",
    }),
  );
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
    ...(deps.boxes ? { boxes: deps.boxes } : {}),
    ...(deps.boxOps ? { boxOps: deps.boxOps } : {}),
    ...(deps.agentOps ? { agentOps: deps.agentOps } : {}),
    ...(deps.agents ? { agents: deps.agents } : {}),
    isMember: deps.isMember,
  });
  const vcs = createVcsModule({
    roots: deps.roots,
    boundary,
    deny,
    git,
    hub: deps.hub,
    clock: deps.clock,
    logger: deps.logger,
    ...(deps.boxes ? { boxes: deps.boxes } : {}),
    ...(deps.boxOps ? { boxOps: deps.boxOps } : {}),
    ...(deps.boxControl ? { boxControl: deps.boxControl } : {}),
    isMember: deps.isMember,
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
    idleMs: deps.config.workerIdleMs,
    ...(deps.boxes ? { boxes: deps.boxes } : {}),
    ...(deps.boxControl ? { boxControl: deps.boxControl } : {}),
    ...(deps.boxTerminals ? { boxTerminals: deps.boxTerminals } : {}),
    isMember: deps.isMember,
  });
  // The deny set's first walk starts now, with its deadline: the first file read does not pay for it.
  deny.warm();
  let stopping: Promise<void> | undefined;
  return {
    rpc: { ...files.rpc, ...vcs.rpc, ...terminal.rpc },
    attachments: files.attachments,
    git,
    boundary,
    deny,
    home: deps.config.home,
    remoteProtocols: deps.config.testGitProtocols ?? "https:ssh",
    runningIn: terminal.runningIn,
    runtime: { scopes: deps.scopes, env: deps.env, umask: workerUmask },
    mount: (app, authenticate) => files.mount(app, httpCaller(authenticate, deps.gate, "files")),
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
