import { ALL_PERMISSIONS, PapError, type Caller, type Permission } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { newId, randomToken, sha256Hex } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SESSION_TTL_MS } from "./cookies.ts";
import { dummyHash, hashPassword, isAcceptablePassword, verifyPassword } from "./passwords.ts";
import type { SetupToken } from "./setup-token.ts";
import type { AuthStore } from "./store.ts";
import type { Throttle } from "./throttle.ts";

// A session's expiry is pushed forward at most once a day: a read is not a write on every request.
const SLIDE_AFTER_MS = 24 * 3600 * 1000;
const MAX_COOKIE_LENGTH = 128;
const MAX_USER_AGENT_LENGTH = 256;
const OWNER_PERMISSIONS: ReadonlySet<Permission> = new Set(ALL_PERMISSIONS);

export class RateLimitedError extends PapError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("rate_limited");
    this.retryAfterMs = retryAfterMs;
  }
}

export interface StartedSession {
  readonly cookieValue: string;
  readonly maxAgeSeconds: number;
}

export interface AuthServiceDeps {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly publicOrigin: string;
  readonly throttle: Throttle;
  readonly setupToken: SetupToken;
}

export interface Credentials {
  readonly username: string;
  readonly password: string;
  readonly ip: string;
  readonly userAgent: string | undefined;
}

export interface AuthService {
  status(cookieValue: string | undefined): {
    setupRequired: boolean;
    authenticated: boolean;
    username: string | null;
  };
  setup(input: Credentials & { token: string }): Promise<StartedSession>;
  login(input: Credentials): Promise<StartedSession>;
  logout(cookieValue: string | undefined): void;
  authenticate(cookieValue: string | undefined): (Caller & { username: string }) | null;
  startSession(userId: string, userAgent: string | undefined): StartedSession;
  setupUrl(): string | null;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  // Hashed up front, so even the first sign-in with an unknown name takes as long as any other.
  void dummyHash().catch(() => undefined);
  const guard = (keys: string[]) => {
    const wait = deps.throttle.retryAfterMs(keys);
    if (wait > 0) throw new RateLimitedError(wait);
  };
  const startSession = (userId: string, userAgent: string | undefined): StartedSession => {
    const cookieValue = randomToken(32);
    const now = deps.clock.now();
    deps.store.deleteExpiredSessions(now);
    deps.store.insertSession({
      idHash: sha256Hex(cookieValue),
      userId,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + SESSION_TTL_MS,
      userAgent: userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null,
    });
    return { cookieValue, maxAgeSeconds: SESSION_TTL_MS / 1000 };
  };
  const authenticate = (cookieValue: string | undefined) => {
    if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null;
    const session = deps.store.findSession(sha256Hex(cookieValue));
    const now = deps.clock.now();
    if (!session || session.expiresAt <= now) return null;
    if (session.expiresAt - now < SESSION_TTL_MS - SLIDE_AFTER_MS) {
      deps.store.extendSession(session.idHash, now, now + SESSION_TTL_MS);
    }
    return { userId: session.userId, username: session.username, permissions: OWNER_PERMISSIONS };
  };
  return {
    status(cookieValue) {
      const caller = authenticate(cookieValue);
      return {
        setupRequired: deps.store.countUsers() === 0,
        authenticated: caller !== null,
        username: caller?.username ?? null,
      };
    },
    async setup(input) {
      const keys = [`ip:${input.ip}`];
      guard(keys);
      if (deps.store.countUsers() > 0 || !deps.setupToken.verify(input.token)) {
        deps.throttle.fail(keys);
        throw new PapError("unauthenticated");
      }
      if (!isAcceptablePassword(input.password)) throw new PapError("bad_request");
      const id = newId();
      const passwordHash = await hashPassword(input.password);
      if (
        !deps.store.insertFirstUser({
          id,
          username: input.username,
          passwordHash,
          createdAt: deps.clock.now(),
        })
      ) {
        throw new PapError("conflict");
      }
      deps.setupToken.consume();
      deps.throttle.succeed(keys);
      deps.logger.info("owner_created", { username: input.username });
      return startSession(id, input.userAgent);
    },
    async login(input) {
      const keys = [`ip:${input.ip}`, `user:${input.username.toLowerCase()}`];
      guard(keys);
      // Counted before the slow hash, so parallel guesses queue behind the first instead of all passing the guard.
      deps.throttle.fail(keys);
      const user = deps.store.findUserByName(input.username);
      const valid = await verifyPassword(input.password, user?.passwordHash ?? (await dummyHash()));
      if (!user || !valid) throw new PapError("unauthenticated");
      deps.throttle.succeed(keys);
      return startSession(user.id, input.userAgent);
    },
    logout(cookieValue) {
      if (cookieValue) deps.store.deleteSession(sha256Hex(cookieValue));
    },
    authenticate,
    startSession,
    setupUrl() {
      const token = deps.setupToken.current();
      return token && deps.store.countUsers() === 0 ? `${deps.publicOrigin}/setup#token=${token}` : null;
    },
  };
}
