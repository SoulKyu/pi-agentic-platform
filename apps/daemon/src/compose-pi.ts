import { dirname, extname, join } from "node:path";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import { type CountedHelperPool, createHelperPool } from "./kernel/helper/pool.ts";
import { createHelperFeed } from "./kernel/helper/status-feed.ts";
import type { Logger } from "./kernel/logger.ts";
import type { StreamHub } from "./kernel/ws/stream-hub.ts";
import { createPiWriteQueue } from "./kernel/pi-write-queue.ts";
import { withLaneRoots } from "./lane-covers.ts";
import { createPluginPicks, type PluginPicks } from "./plugin-picks.ts";
import { type AgentsPackagesRpc, agentsPackagesRpc, createAgentPackages } from "./modules/agents/index.ts";
import { createMcpModule, type McpModule } from "./modules/mcp/index.ts";
import { createModelsModule, type ModelsModule, sweepValidationCopies } from "./modules/models/index.ts";
import { createSkillsModule, type SkillsModule } from "./modules/skills/index.ts";
import { createTrustModule, type TrustModule } from "./modules/trust/index.ts";
import type { AuditModule } from "./modules/audit/index.ts";
import type { PolicyModule } from "./modules/policy/index.ts";
import type { ProjectsModule } from "./modules/projects/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";
import type { SettingsModule } from "./modules/settings/index.ts";

export interface ComposePiDeps {
  readonly config: Config;
  readonly env: NodeJS.ProcessEnv;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly hub: StreamHub;
  readonly audit: AuditModule;
  readonly policy: PolicyModule;
  readonly projects: ProjectsModule;
  readonly sessions: SessionsModule;
  readonly settings: SettingsModule;
}

export interface ComposedPi {
  /** Every Pi method this milestone adds; each later task adds its module's table here (with `&`), never in `daemon.ts`. */
  readonly rpc: ModelsModule["rpc"] &
    McpModule["rpc"] &
    TrustModule["rpc"] &
    SkillsModule["rpc"] &
    AgentsPackagesRpc;
  /** What lanes ask of trust: a worktree inherits its project's decision (M9R39). */
  readonly trust: TrustModule["port"];
  /** The models Pi offers, for the VM relay's per-agent policy (R13). */
  readonly models: ModelsModule["port"];
  /** The agent form's package ids, resolved to the exact sources in the helper (AVM-E33). */
  readonly plugins: PluginPicks;
  /** The pool every Pi module runs its configuration work in (ADR 0023): for the modules composed here and for tests. */
  readonly helpers: CountedHelperPool;
  /** The Pi modules answer for the owner's non-archived lane folders as for a project root (final review I1); bound by `lanes.bind`. */
  useLaneRoots(roots: (ownerId: string) => readonly string[]): void;
  /** Who hears the helper counts: the owners with a live `launches` subscription, asked at each send (late bound, `agentsVm.bindLate`). */
  bindHelperOwners(owners: () => readonly string[]): void;
  /** The helpers' kill ladders, at most 5 s: the daemon runs it together with `sessions.shutdownAll()`. */
  stopAll(): Promise<void>;
}

/**
 * Where the daemon's Pi modules are wired (M7R151), mirroring `compose-workspace.ts`: `daemon.ts` gains a call and a
 * spread, and this file grows with each module. The helper's entry is the worker's neighbour (`<dist or src>/helper/main`),
 * so it is built and found the same way.
 */
export function composePi(deps: ComposePiDeps): ComposedPi {
  const { config } = deps;
  // Bound by `lanes.bind`, after both exist: until then nothing lane-related is covered, which fails closed.
  let laneRoots: (ownerId: string) => readonly string[] = () => [];
  const projects = withLaneRoots(deps.projects.port, (owner) => laneRoots(owner));
  let helperOwners: () => readonly string[] = () => [];
  const feed = createHelperFeed({
    clock: deps.clock,
    send(status) {
      // No ids: the same counts go to every owner who watches launches.
      for (const owner of helperOwners()) {
        try {
          deps.hub.publish("launches", owner, { kind: "helpers", helpers: status });
        } catch (error) {
          deps.logger.warn("helper_publish_failed", { err: error });
        }
      }
    },
  });
  const helpers = createHelperPool({
    entry: join(dirname(config.piHostEntry), "helper", `main${extname(config.piHostEntry)}`),
    execArgv: config.piHostExecArgv,
    baseEnv: deps.env,
    agentDir: config.piAgentDir,
    papHome: config.home,
    // The test operations of the helper exist only with a scripted provider, like the worker's (ADR 0001).
    extraEnv: config.testProviderScript ? { PAP_TEST_PROVIDER: "1" } : {},
    max: config.helpersMax,
    onChange: feed.push,
    clock: deps.clock,
    logger: deps.logger,
  });
  void sweepValidationCopies(config.home, deps.logger);
  // One queue for every write of Pi's own files: the models and the MCP/code mode writes never overlap (MC29).
  const writes = createPiWriteQueue();
  const models = createModelsModule({
    helpers,
    projects,
    logger: deps.logger,
    clock: deps.clock,
    audit: deps.audit.port,
    hub: deps.hub,
    settings: deps.settings.port,
    writes,
  });
  const mcp = createMcpModule({
    helpers,
    projects,
    logger: deps.logger,
    clock: deps.clock,
    writes,
  });
  const trust = createTrustModule({
    helpers,
    projects,
    sessions: deps.sessions,
    audit: deps.audit.port,
    logger: deps.logger,
    clock: deps.clock,
  });
  const skills = createSkillsModule({
    helpers,
    projects,
    logger: deps.logger,
    clock: deps.clock,
    writes,
    audit: deps.audit.port,
  });
  return {
    rpc: {
      ...models.rpc,
      ...mcp.rpc,
      ...trust.rpc,
      ...skills.rpc,
      ...agentsPackagesRpc(createAgentPackages({ helpers, logger: deps.logger })),
    },
    trust: trust.port,
    models: models.port,
    plugins: createPluginPicks({ helpers, logger: deps.logger }),
    helpers,
    useLaneRoots: (roots) => void (laneRoots = roots),
    bindHelperOwners: (owners) => void (helperOwners = owners),
    stopAll: async () => {
      await helpers.stopAll();
      feed.stop();
    },
  };
}
