import type { Hono } from "hono";
import type { BoxControl, BoxOps } from "./kernel/boxes.ts";
import type { Clock } from "./kernel/clock.ts";
import type { Config } from "./kernel/config.ts";
import type { Db } from "./kernel/db/database.ts";
import { httpCaller } from "./kernel/http/caller.ts";
import type { Logger } from "./kernel/logger.ts";
import type { AuditPort } from "./modules/audit/index.ts";
import type { AuthModule } from "./modules/auth/index.ts";
import {
  createGithubFeature,
  createGithubModule,
  createGithubProjectsFeature,
  type GithubAccountRpc,
  type GithubCore,
  type GithubProjectsFeature,
  type GithubSessionsPort,
} from "./modules/github/index.ts";
import type { PolicyPort } from "./modules/policy/index.ts";
import type { ProjectsModule } from "./modules/projects/index.ts";
import { createVaultStore, vaultRootOf } from "./modules/secrets/index.ts";
import type { SessionsModule } from "./modules/sessions/index.ts";

/**
 * The GitHub core, built before the VM composition so the owner-secrets collector can mask the box tokens in use. The real
 * origins unless the config names the fake GitHub (`PAP_TEST_GITHUB_ORIGIN`, which only a test boot can set): then, and only
 * then, the client accepts plain http on loopback.
 */
export function createGithubCore(
  config: Pick<Config, "home" | "testGithubOrigin">,
  clock: Clock,
  logger: Logger,
): GithubCore {
  const fake = config.testGithubOrigin;
  return createGithubModule({
    home: config.home,
    vault: createVaultStore(vaultRootOf(config.home), { sweep: false }),
    clock,
    logger,
    ...(fake === null ? {} : { apiOrigin: fake, webOrigin: fake, test: true }),
  });
}

/** "Send to a session" over the sessions and policy ports (lanes use the same ones). */
export function githubSessionsPort(
  sessions: Pick<SessionsModule, "lanes">,
  policy: Pick<PolicyPort, "markTainted">,
): GithubSessionsPort {
  return {
    create: (caller, cwd) => sessions.lanes.create(caller, cwd, null),
    prompt: (caller, sessionId, text) => sessions.lanes.prompt(caller, sessionId, text),
    // The owner's own sessions in the project's folder: another user's id is never in the list.
    sessionIdsIn: (ownerId, folder) => sessions.lanes.sessionIdsIn(ownerId, folder),
    markTainted: (ownerId, sessionId) => policy.markTainted(ownerId, sessionId),
  };
}

export interface GithubDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: Pick<Config, "allowedOrigins" | "home">;
  readonly audit: { readonly port: AuditPort };
  readonly auth: Pick<AuthModule, "authenticateCookieHeader">;
  readonly projects: ProjectsModule;
  readonly sessions: Pick<SessionsModule, "lanes">;
  readonly policy: { readonly port: PolicyPort };
  readonly boxes: { readonly control: BoxControl; readonly ops: BoxOps };
  readonly closers: Array<{ readonly name: string; close(): void | Promise<void> }>;
}

export interface GithubComposition {
  readonly rpc: GithubAccountRpc & GithubProjectsFeature["rpc"];
  mount(app: Hono): void;
}

/** App creation, projects from GitHub, the delivery loop on the box phases and the key sweep (boxes B2). */
export function composeGithub(core: GithubCore, deps: GithubDeps): GithubComposition {
  const logger = deps.logger.child({ module: "github" });
  const feature = createGithubFeature(core, {
    audit: deps.audit.port,
    clock: deps.clock,
    logger,
    httpCaller: httpCaller(deps.auth.authenticateCookieHeader),
    allowedOrigins: deps.config.allowedOrigins,
  });
  const projects = createGithubProjectsFeature(core, {
    db: deps.db,
    audit: deps.audit.port,
    clock: deps.clock,
    logger,
    projects: deps.projects,
    permissionMissing: () => feature.service.setPermissionMissing(true),
    sessions: githubSessionsPort(deps.sessions, deps.policy.port),
  });
  deps.closers.push(
    { name: "github_delivery", close: projects.bind(deps.boxes) },
    { name: "github_keys", close: projects.start() },
  );
  return { rpc: { ...feature.rpc, ...projects.rpc }, mount: feature.mount };
}
