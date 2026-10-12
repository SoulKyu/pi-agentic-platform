import { fileURLToPath } from "node:url";
import type { Caller } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { cookieNeedsSecure, readCookie, SESSION_COOKIE } from "./cookies.ts";
import { mountAuthRoutes } from "./http.ts";
import { mountPasskeyRoutes } from "./passkey-http.ts";
import { createPasskeyService } from "./passkeys.ts";
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
  /** `--insecure-http`: session cookies without Secure on plain HTTP (LAN testing). */
  readonly insecureHttp?: boolean;
  readonly audit: Pick<AuditPort, "append">;
}

export interface AuthModule {
  mount(app: Hono): void;
  /** The `pap_session` value in a Cookie header, the only part of it that is ever kept. */
  sessionValueOf(header: string | undefined): string | undefined;
  /** `slide: false` checks without extending the session (see `AuthService.authenticate`). */
  authenticateSession(value: string | undefined, options?: { readonly slide?: boolean }): Caller | null;
  authenticateCookieHeader(header: string | undefined): Caller | null;
  /** The one-time owner setup URL while no owner exists, else null. The only secret meant to be shown. */
  setupUrl(): string | null;
  /** The instance owner: the oldest user, the one definition of it (M4R61, agreement 6). */
  ownerId(): string | null;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const store = createAuthStore(deps.db);
  const logger = deps.logger.child({ module: "auth" });
  const sessionThrottle = createThrottle(deps.clock, { whenFull: "refuse" });
  const service = createAuthService({
    store,
    clock: deps.clock,
    logger,
    publicOrigin: deps.publicOrigin,
    throttle: createThrottle(deps.clock, { whenFull: "refuse" }),
    sessionThrottle,
    setupToken: createSetupToken(store.countUsers() === 0),
    audit: deps.audit,
  });
  const passkeys = createPasskeyService({
    store,
    clock: deps.clock,
    publicOrigin: deps.publicOrigin,
    allowedOrigins: deps.allowedOrigins,
  });
  // Separate from the password throttle: a lockout of one must never lock the other (R80).
  const passkeyThrottle = createThrottle(deps.clock, { whenFull: "evict" });
  const secureByConfig = cookieNeedsSecure(deps.publicOrigin);
  return {
    mount: (app) => {
      mountAuthRoutes(app, {
        service,
        passkeysAvailable: passkeys.available,
        secureByConfig,
        insecureHttp: deps.insecureHttp === true,
      });
      mountPasskeyRoutes(app, {
        passkeys,
        auth: service,
        throttle: passkeyThrottle,
        sessionThrottle,
        logger,
      });
    },
    sessionValueOf: (header) => readCookie(header, SESSION_COOKIE),
    authenticateSession: (value, options) => service.authenticate(value, options),
    authenticateCookieHeader: (header) => service.authenticate(readCookie(header, SESSION_COOKIE)),
    setupUrl: () => service.setupUrl(),
    ownerId: () => store.firstUserId(),
  };
}
