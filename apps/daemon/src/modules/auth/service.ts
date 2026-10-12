import { ALL_PERMISSIONS, PapError, type Caller, type Permission } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import { isReadOnlyError } from "../../kernel/db/read-only.ts";
import { newId, randomToken, sha256Hex } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import { SESSION_TTL_MS } from "./cookies.ts";
import { dummyHash, hashPassword, isAcceptablePassword, verifyPassword } from "./passwords.ts";
import type { SetupToken } from "./setup-token.ts";
import type { AuthStore, UserRow } from "./store.ts";
import type { Throttle } from "./throttle.ts";

// A session's expiry is pushed forward at most once a day: a read is not a write on every request.
const SLIDE_AFTER_MS = 24 * 3600 * 1000;
const MAX_COOKIE_LENGTH = 128;
const MAX_USER_AGENT_LENGTH = 256;
// A throttled client may retry every few milliseconds: one log line per address and window, not one per request.
const THROTTLE_LOG_WINDOW_MS = 10_000;
const MAX_THROTTLE_LOG_KEYS = 1000;
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
  /** Step-up for a signed-in caller: the account's password, checked and throttled exactly like a sign-in. */
  confirmPassword(input: { userId: string; password: string; ip: string }): Promise<void>;
  logout(cookieValue: string | undefined): void;
  /**
   * Who the session value belongs to. A request slides the expiry (at most once a day); `slide: false` only looks,
   * for the keepalive tick of an open socket, so that an idle socket cannot keep a session alive.
   */
  authenticate(
    cookieValue: string | undefined,
    options?: { readonly slide?: boolean },
  ): (Caller & { username: string }) | null;
  startSession(userId: string, userAgent: string | undefined): StartedSession;
  setupUrl(): string | null;
}

export function createAuthService(deps: AuthServiceDeps): AuthService {
  // Hashed up front, so even the first sign-in with an unknown name takes as long as any other.
  void dummyHash().catch(() => undefined);
  // Security events carry the socket address and the delay in force, never a username, a password or a token:
  // people type one into the other's field, and a log is read by more eyes than a database.
  const lastThrottleLog = new Map<string, number>();
  const guard = (keys: string[], ip: string) => {
    const wait = deps.throttle.retryAfterMs(keys);
    if (wait <= 0) return;
    const now = deps.clock.now();
    if (now - (lastThrottleLog.get(ip) ?? -Infinity) >= THROTTLE_LOG_WINDOW_MS) {
      if (lastThrottleLog.size >= MAX_THROTTLE_LOG_KEYS) lastThrottleLog.clear();
      lastThrottleLog.set(ip, now);
      deps.logger.warn("auth_throttled", { ip, retryAfterMs: wait });
    }
    throw new RateLimitedError(wait);
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
  // Sign-in and step-up end alike: guard, count the attempt before the slow hash, verify against the stored hash
  // (an unknown name against the dummy one; if even that cannot be computed it is a plain mismatch, never an
  // error that a known name would not produce).
  const checkPassword = async (
    keys: string[],
    ip: string,
    user: UserRow | undefined,
    password: string,
  ): Promise<UserRow> => {
    guard(keys, ip);
    // Counted before the slow hash, so parallel guesses queue behind the first instead of all passing the guard.
    deps.throttle.fail(keys);
    const stored = user?.passwordHash ?? (await dummyHash().catch(() => ""));
    const valid = await verifyPassword(password, stored);
    if (!user || !valid) {
      deps.logger.warn("auth_login_failed", { ip, retryAfterMs: deps.throttle.retryAfterMs(keys) });
      throw new PapError("unauthenticated");
    }
    deps.throttle.succeed(keys);
    return user;
  };
  const authenticate: AuthService["authenticate"] = (cookieValue, options) => {
    if (!cookieValue || cookieValue.length > MAX_COOKIE_LENGTH) return null;
    const session = deps.store.findSession(sha256Hex(cookieValue));
    const now = deps.clock.now();
    if (!session || session.expiresAt <= now) return null;
    if (options?.slide !== false && session.expiresAt - now < SESSION_TTL_MS - SLIDE_AFTER_MS) {
      try {
        deps.store.extendSession(session.idHash, now, now + SESSION_TTL_MS);
      } catch (error) {
        // A database written by a newer pap is read-only: the session is still valid, it just cannot slide.
        if (!isReadOnlyError(error)) throw error;
      }
    }
    return {
      userId: session.userId,
      username: session.username,
      permissions: OWNER_PERMISSIONS,
      kind: "session",
      credentialId: "",
      stepUpUntil: 0,
    };
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
      guard(keys, input.ip);
      if (deps.store.countUsers() > 0 || !deps.setupToken.verify(input.token)) {
        deps.throttle.fail(keys);
        deps.logger.warn("auth_setup_failed", {
          ip: input.ip,
          retryAfterMs: deps.throttle.retryAfterMs(keys),
        });
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
      deps.logger.info("owner_created", { userId: id });
      return startSession(id, input.userAgent);
    },
    async login(input) {
      const keys = [`ip:${input.ip}`, `user:${input.username.toLowerCase()}`];
      const user = await checkPassword(
        keys,
        input.ip,
        deps.store.findUserByName(input.username),
        input.password,
      );
      return startSession(user.id, input.userAgent);
    },
    async confirmPassword(input) {
      const user = deps.store.findUserById(input.userId);
      const keys = [`ip:${input.ip}`, `user:${(user?.username ?? "").toLowerCase()}`];
      await checkPassword(keys, input.ip, user, input.password);
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
