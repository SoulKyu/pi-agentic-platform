import { isIP } from "node:net";
import { PapError } from "@pap/contracts";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticatorTransportFuture,
} from "@simplewebauthn/server";
import type { Clock } from "../../kernel/clock.ts";
import { randomToken } from "../../kernel/ids.ts";
import type { Logger } from "../../kernel/logger.ts";
import { createLoginChallenges } from "./login-challenge.ts";
import { passkeyRefOf, sanitizeTransports } from "./passkey-store.ts";
import type { AuthStore } from "./store.ts";

const FLOW_TTL_MS = 5 * 60_000;
// Enrollment flows exist only for a signed-in caller who also gave the password, so 100 pending is plenty.
const MAX_FLOWS = 100;
const FULL_LOG_WINDOW_MS = 10_000;

export interface WebAuthnLib {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}
const realLib: WebAuthnLib = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export function rpIdFor(origin: string): string | null {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, "");
    return isIP(host) === 0 ? host : null;
  } catch {
    return null;
  }
}

export interface PasskeyService {
  readonly available: boolean;
  /** `sessionHash` is the id hash of the browser session asking: only that session may finish the flow (R85). */
  registerOptions(userId: string, sessionHash: string): Promise<{ flowId: string; options: unknown }>;
  registerVerify(userId: string, sessionHash: string, flowId: string, response: unknown): Promise<void>;
  loginOptions(): Promise<{ flowId: string; options: unknown }>;
  /** The user the passkey belongs to, and the passkey's short id: the session it opens remembers it (M5R128). */
  loginVerify(flowId: string, response: unknown): Promise<{ userId: string; passkeyRef: string }>;
}

export interface PasskeyDeps {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly lib?: WebAuthnLib;
  /** Receives `auth_login_challenges_full` (no fields), at most once per 10 s. */
  readonly logger: Logger;
}

interface Flow {
  readonly challenge: string;
  readonly userId: string;
  readonly sessionHash: string;
  readonly expiresAt: number;
}

// Pending enrollments. A flow is gone after its first verify attempt, whatever the outcome (also one from a
// session that did not start it), after five minutes, and as the oldest once more than MAX_FLOWS wait. Sign-ins keep no such state (login-challenge.ts).
function createFlows(clock: Clock) {
  const pending = new Map<string, Flow>();
  return {
    remember(challenge: string, userId: string, sessionHash: string): string {
      const now = clock.now();
      for (const [id, flow] of pending) if (flow.expiresAt <= now) pending.delete(id);
      while (pending.size >= MAX_FLOWS) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
      }
      const flowId = randomToken(16);
      pending.set(flowId, { challenge, userId, sessionHash, expiresAt: now + FLOW_TTL_MS });
      return flowId;
    },
    take(flowId: string, userId: string, sessionHash: string): Flow {
      const flow = pending.get(flowId);
      pending.delete(flowId);
      if (
        !flow ||
        flow.expiresAt <= clock.now() ||
        flow.userId !== userId ||
        flow.sessionHash !== sessionHash
      ) {
        throw new PapError("unauthenticated");
      }
      return flow;
    },
  };
}

// What an authenticator reports as the user handle: the bytes registerOptions gave as user.id.
const userHandleOf = (userId: string): string => Buffer.from(userId).toString("base64url");

// The library's reasons (wrong origin, no user verification, counter regressed) stay out of responses and logs.
async function attempt<T>(run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch {
    return null;
  }
}

export function createPasskeyService(deps: PasskeyDeps): PasskeyService {
  const rpID = rpIdFor(deps.publicOrigin);
  const lib = deps.lib ?? realLib;
  const origins = rpID === null ? [] : [...deps.allowedOrigins].filter((origin) => rpIdFor(origin) === rpID);
  const registrations = createFlows(deps.clock);
  let lastFullLog = -Infinity;
  const logins = createLoginChallenges(deps.clock, FLOW_TTL_MS, undefined, () => {
    const now = deps.clock.now();
    if (now - lastFullLog < FULL_LOG_WINDOW_MS) return;
    lastFullLog = now;
    deps.logger.warn("auth_login_challenges_full", {});
  });
  const requireRp = (): string => {
    if (!rpID) throw new PapError("not_found");
    return rpID;
  };
  return {
    available: rpID !== null,
    async registerOptions(userId, sessionHash) {
      const rp = requireRp();
      const user = deps.store.findUserById(userId);
      if (!user) throw new PapError("unauthenticated");
      const options = await lib.generateRegistrationOptions({
        rpName: "pap",
        rpID: rp,
        userName: user.username,
        userID: new TextEncoder().encode(user.id),
        attestationType: "none",
        excludeCredentials: deps.store.listPasskeys(userId).map((p) => ({
          id: p.id,
          transports: p.transports as AuthenticatorTransportFuture[],
        })),
        // A passkey replaces the password, so the authenticator must verify the user (PIN or biometrics) itself.
        authenticatorSelection: { residentKey: "required", userVerification: "required" },
      });
      return { flowId: registrations.remember(options.challenge, userId, sessionHash), options };
    },
    async registerVerify(userId, sessionHash, flowId, response) {
      const rp = requireRp();
      const flow = registrations.take(flowId, userId, sessionHash);
      const result = await attempt(() =>
        lib.verifyRegistrationResponse({
          response: response as never,
          expectedChallenge: flow.challenge,
          expectedOrigin: origins,
          expectedRPID: rp,
          requireUserVerification: true,
        }),
      );
      if (!result?.verified || !result.registrationInfo) throw new PapError("unauthenticated");
      const { credential } = result.registrationInfo;
      // Checked and inserted without an await in between: no second enrollment can slip in.
      if (deps.store.findPasskey(credential.id)) throw new PapError("conflict");
      deps.store.insertPasskey({
        id: credential.id,
        userId,
        publicKey: credential.publicKey,
        counter: credential.counter,
        transports: sanitizeTransports(credential.transports),
        createdAt: deps.clock.now(),
      });
    },
    async loginOptions() {
      const rp = requireRp();
      const challenge = logins.issue();
      const options = await lib.generateAuthenticationOptions({
        rpID: rp,
        userVerification: "required",
        allowCredentials: [],
        challenge: new Uint8Array(challenge),
      });
      return { flowId: challenge.toString("base64url"), options };
    },
    async loginVerify(flowId, response) {
      const rp = requireRp();
      const sent = response as { id?: unknown; response?: { userHandle?: unknown } } | null;
      const passkey = typeof sent?.id === "string" ? deps.store.findPasskey(sent.id) : undefined;
      if (!passkey) throw new PapError("unauthenticated");
      // WebAuthn L2 7.2 step 6: a reported user handle must name the credential's own user.
      const handle = sent?.response?.userHandle;
      if (handle !== undefined && handle !== userHandleOf(passkey.userId)) {
        throw new PapError("unauthenticated");
      }
      // The flow id is the challenge: taking it proves we issued it, and the library below checks that the
      // authenticator signed exactly this one. Only an answer for a registered credential records its nonce, so a
      // spray of garbage cannot fill the used-nonce map; the nonce is still spent before the slow verification (R85).
      logins.take(flowId);
      const result = await attempt(() =>
        lib.verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: flowId,
          expectedOrigin: origins,
          expectedRPID: rp,
          credential: {
            id: passkey.id,
            publicKey: passkey.publicKey as Uint8Array<ArrayBuffer>,
            counter: passkey.counter,
            transports: passkey.transports as AuthenticatorTransportFuture[],
          },
          requireUserVerification: true,
        }),
      );
      if (!result?.verified) throw new PapError("unauthenticated");
      // The library compared the counter with the one read before its await. If another sign-in advanced it
      // meanwhile, this assertion is a replay of the same counter: refuse it. No await between check and write.
      if (deps.store.findPasskey(passkey.id)?.counter !== passkey.counter) {
        throw new PapError("unauthenticated");
      }
      deps.store.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter, deps.clock.now());
      return { userId: passkey.userId, passkeyRef: passkeyRefOf(passkey.id) };
    },
  };
}
