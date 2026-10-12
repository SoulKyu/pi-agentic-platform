import { randomBytes } from "node:crypto";
import type { Permission } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Db } from "../../kernel/db/database.ts";
import { silentLogger, type Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { createKnownDevices } from "./known-device.ts";
import { createDevices } from "./devices.ts";
import { createPasskeyManager } from "./passkey-manage.ts";
import { createAuthService } from "./service.ts";
import { createSetupToken } from "./setup-token.ts";
import { createStepUps } from "./step-up.ts";
import { createAuthStore } from "./store.ts";
import { createAuthThrottles } from "./throttle.ts";
import { createTokenStore, type TokenStore } from "./token-store.ts";
import { createTokenService } from "./tokens.ts";

export interface AuthTestHarnessDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly audit: Pick<AuditPort, "append">;
  readonly logger?: Logger;
}

export interface TestTokenOptions {
  readonly newId: () => string;
  readonly ownerPermissions: () => ReadonlySet<Permission>;
  /** Another handle on the same file (a read-only one, say). */
  readonly db?: Db;
  /** Wraps the real store, to count its calls. */
  readonly instrument?: (real: TokenStore) => TokenStore;
}

/**
 * The one door the module's `testing/` beds use to reach real services on a test database. Each service is the
 * production factory, but this wiring is written out by hand and is not `createAuthModule`'s: it can drift from it
 * (it has no device key file, for one), so a change to that wiring is mirrored here by hand.
 */
export function createAuthTestHarness(deps: AuthTestHarnessDeps) {
  const logger = deps.logger ?? silentLogger;
  const store = createAuthStore(deps.db);
  const stepUps = createStepUps(deps.clock);
  const throttles = createAuthThrottles(deps.clock);
  const service = createAuthService({
    devices: createKnownDevices(randomBytes(32)),
    store,
    clock: deps.clock,
    logger,
    publicOrigin: "http://localhost:7777",
    throttle: throttles.password,
    sessionThrottle: throttles.session,
    setupToken: createSetupToken(false),
    audit: deps.audit,
    stepUps,
  });
  return {
    store,
    stepUps,
    service,
    devices: createDevices({ store, service, clock: deps.clock, audit: deps.audit }),
    passkeys: createPasskeyManager({ store, service, clock: deps.clock, audit: deps.audit }),
    tokens(options: TestTokenOptions) {
      const real = createTokenStore(options.db ?? deps.db, logger);
      return createTokenService({
        store: options.instrument?.(real) ?? real,
        clock: deps.clock,
        audit: deps.audit,
        newId: options.newId,
        ownerPermissions: options.ownerPermissions,
      });
    },
  };
}
