import { join } from "node:path";
import type { RepoFullName } from "@pap/contracts";
import { hostname } from "node:os";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { HttpCaller } from "../../kernel/http/caller.ts";
import type { AuditPort } from "../audit/index.ts";
import type { VaultStore } from "../secrets/index.ts";
import { type AppSecretsStore, createAppSecrets } from "./app-secrets.ts";
import { createGithubClient, type GithubClient, type Resolver } from "./client.ts";
import { mountGithubRoutes } from "./http.ts";
import { type GithubAccountRpc, githubAccountRpc } from "./rpc.ts";
import { createGithubService, type GithubService } from "./service.ts";
import { createStates, type GithubStates } from "./states.ts";
import { createTokens, type GithubTokens } from "./tokens.ts";
import { createUserTokens, type UserTokens } from "./user-tokens.ts";

export { type GithubAppFile, githubAppSecretValues } from "./app-secrets.ts";
export type { GithubClient } from "./client.ts";
export type { GithubStates } from "./states.ts";
export type { GithubTokens } from "./tokens.ts";
export type { UserTokens } from "./user-tokens.ts";

export { assertBrowserCaller } from "./browser-only.ts";
export { createGithubProjectsFeature, type GithubProjectsFeature } from "./projects-feature.ts";
export type { GithubSessionsPort } from "./send.ts";
export type { GithubProjectRow, GithubProjectStore } from "./project-store.ts";

export interface GithubModuleDeps {
  readonly home: string;
  readonly vault: VaultStore;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Default `https://api.github.com` and `https://github.com`; anything else needs `test` (the fake GitHub on loopback). */
  readonly apiOrigin?: string;
  readonly webOrigin?: string;
  readonly test?: boolean;
  readonly resolve?: Resolver;
}

export interface GithubCore {
  readonly client: GithubClient;
  readonly appSecrets: AppSecretsStore;
  readonly tokens: GithubTokens;
  readonly userTokens: UserTokens;
  readonly states: GithubStates;
  /** Built here from a validated name and the fixed web origin; a URL from outside is never accepted. */
  cloneUrl(repo: RepoFullName): string;
}

export function createGithubModule(deps: GithubModuleDeps): GithubCore {
  const client = createGithubClient({
    clock: deps.clock,
    apiOrigin: deps.apiOrigin,
    webOrigin: deps.webOrigin,
    test: deps.test,
    resolve: deps.resolve,
    logger: deps.logger,
  });
  const appSecrets = createAppSecrets({ secretsDir: join(deps.home, "secrets"), logger: deps.logger });
  return {
    client,
    appSecrets,
    tokens: createTokens({ client, appSecrets, clock: deps.clock }),
    userTokens: createUserTokens({
      vault: deps.vault,
      client,
      appSecrets,
      clock: deps.clock,
      logger: deps.logger,
    }),
    states: createStates({ clock: deps.clock }),
    cloneUrl: (repo) => `${client.webOrigin}/${repo}.git`,
  };
}

export type { GithubAccountRpc } from "./rpc.ts";
export type { GithubService } from "./service.ts";

export interface GithubFeatureDeps {
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly httpCaller: HttpCaller;
  readonly allowedOrigins: ReadonlySet<string>;
  /** Default: the host's first name part. */
  readonly hostLabel?: string;
}

export interface GithubFeature {
  readonly service: GithubService;
  readonly rpc: GithubAccountRpc;
  /** The App flow's routes under `/github`; mounted once, with the other modules'. */
  mount(app: Hono): void;
}

/** App creation and authorization (B2) on a module core: the account RPCs and the browser routes. */
export function createGithubFeature(core: GithubCore, deps: GithubFeatureDeps): GithubFeature {
  const service = createGithubService({
    core,
    audit: deps.audit,
    clock: deps.clock,
    logger: deps.logger,
    allowedOrigins: deps.allowedOrigins,
    hostLabel: deps.hostLabel ?? hostname().split(".")[0] ?? "host",
  });
  return {
    service,
    rpc: githubAccountRpc(service),
    mount: (app) => mountGithubRoutes(app, { service, httpCaller: deps.httpCaller }),
  };
}
