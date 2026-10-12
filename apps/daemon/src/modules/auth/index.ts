import { fileURLToPath } from "node:url";
import type { Caller } from "@pap/contracts";
import type { Hono } from "hono";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import type { MigrationSource } from "../../kernel/db/migrate.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { newId } from "../../kernel/ids.ts";
import type { Credential } from "../../kernel/ws/ws-server.ts";
import { cookieNeedsSecure, readCookie, SESSION_COOKIE } from "./cookies.ts";
import { credentialOf } from "./credentials.ts";
import { createDevices } from "./devices.ts";
import { mountAuthRoutes } from "./http.ts";
import { createKnownDevices, loadDeviceKey } from "./known-device.ts";
import { createPasskeyManager } from "./passkey-manage.ts";
import { mountPasskeyRoutes } from "./passkey-http.ts";
import { createPasskeyService } from "./passkeys.ts";
import { type AuthRpc, authRpc } from "./rpc.ts";
import { createAuthService, OWNER_PERMISSIONS } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createAuthStore } from "./store.ts";
import { createTokenStore } from "./token-store.ts";
import { createTokenService } from "./tokens.ts";
import { createAuthThrottles } from "./throttle.ts";

// The one export for `testing/` beds (R84): real services on a test database, no loose factories.
export { createAuthTestHarness } from "./test-seam.ts";

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
  /** `$PAP_HOME/secrets`: where `device.key` lives (0600). */
  readonly secretsDir: string;
}

export interface AuthModule {
  readonly rpc: AuthRpc;
  mount(app: Hono): void;
  /** The one credential of a request: the session cookie or the bearer, "conflict" when both (M5R70, M5R71). */
  credentialOf(headers: {
    readonly cookie?: string | undefined;
    readonly authorization?: string | undefined;
  }): Credential | "conflict" | undefined;
  /** Who a cookie or a bearer belongs to, or null. `slide: false` checks without extending or writing the last use. */
  authenticateCredential(
    credential: Credential | undefined,
    options?: { readonly slide?: boolean },
  ): Caller | null;
  authenticateCookieHeader(header: string | undefined): Caller | null;
  /** The one-time owner setup URL while no owner exists, else null. The only secret meant to be shown. */
  setupUrl(): string | null;
  /** The instance owner: the oldest user, the one definition of it (M4R61, agreement 6). */
  ownerId(): string | null;
}

export function createAuthModule(deps: AuthModuleDeps): AuthModule {
  const store = createAuthStore(deps.db);
  const logger = deps.logger.child({ module: "auth" });
  const throttles = createAuthThrottles(deps.clock);
  const knownDevices = createKnownDevices(loadDeviceKey(deps.secretsDir, logger));
  const service = createAuthService({
    store,
    clock: deps.clock,
    logger,
    publicOrigin: deps.publicOrigin,
    throttle: throttles.password,
    sessionThrottle: throttles.session,
    setupToken: createSetupToken(store.countUsers() === 0),
    audit: deps.audit,
    devices: knownDevices,
  });
  const passkeys = createPasskeyService({
    store,
    clock: deps.clock,
    publicOrigin: deps.publicOrigin,
    allowedOrigins: deps.allowedOrigins,
    logger,
  });
  const tokens = createTokenService({
    store: createTokenStore(deps.db, logger),
    clock: deps.clock,
    audit: deps.audit,
    newId,
    ownerPermissions: () => OWNER_PERMISSIONS,
  });
  const devices = createDevices({ store, service, clock: deps.clock, audit: deps.audit });
  const passkeyManager = createPasskeyManager({ store, service, clock: deps.clock, audit: deps.audit });
  // Separate from the password throttle: a lockout of one must never lock the other (R80).
  const secureByConfig = cookieNeedsSecure(deps.publicOrigin);
  return {
    rpc: authRpc(tokens, devices, passkeyManager),
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
        throttle: throttles.passkey,
        devices: knownDevices,
        userOfPasskey: (credentialId) => store.findPasskey(credentialId)?.userId,
        logger,
        audit: deps.audit,
      });
    },
    credentialOf,
    authenticateCredential: (credential, options) => {
      if (!credential) return null;
      return credential.kind === "cookie"
        ? service.authenticate(credential.value, options)
        : tokens.authenticate(credential.value, { slide: options?.slide !== false });
    },
    authenticateCookieHeader: (header) => service.authenticate(readCookie(header, SESSION_COOKIE)),
    setupUrl: () => service.setupUrl(),
    ownerId: () => store.firstUserId(),
  };
}
