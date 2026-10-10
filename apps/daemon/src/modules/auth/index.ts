import { fileURLToPath } from "node:url";
import type { Caller } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import { cookieNeedsSecure, readCookie, SESSION_COOKIE } from "./cookies.ts";
import { mountAuthRoutes } from "./http.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createThrottle } from "./throttle.ts";

export const AUTH_MIGRATIONS: MigrationSource = {
  module: "auth",
  dir: fileURLToPath(new URL("./migrations/", import.meta.url)),
};

export interface AuthModuleDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
}

export interface AuthModule {
  mount(app: Hono): void;
  authenticateCookieHeader(header: string | undefined): Caller | null;
  /** The one-time owner setup URL while no owner exists, else null. The only secret meant to be shown. */
  setupUrl(): string | null;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const store = createAuthStore(deps.db);
  const service = createAuthService({
    store,
    clock: deps.clock,
    logger: deps.logger.child({ module: "auth" }),
    publicOrigin: deps.publicOrigin,
    throttle: createThrottle(deps.clock),
    setupToken: createSetupToken(store.countUsers() === 0),
  });
  const secureByConfig = cookieNeedsSecure(deps.publicOrigin);
  return {
    mount: (app) => mountAuthRoutes(app, { service, passkeysAvailable: false, secureByConfig }),
    authenticateCookieHeader: (header) => service.authenticate(readCookie(header, SESSION_COOKIE)),
    setupUrl: () => service.setupUrl(),
  };
}
