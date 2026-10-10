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
import type { AuthStore } from "./store.ts";

const FLOW_TTL_MS = 5 * 60_000;
// Per kind: an unauthenticated flood of login options must not evict an enrollment in progress.
const MAX_FLOWS = 100;

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
  registerOptions(userId: string): Promise<{ flowId: string; options: unknown }>;
  registerVerify(userId: string, flowId: string, response: unknown): Promise<void>;
  loginOptions(): Promise<{ flowId: string; options: unknown }>;
  loginVerify(flowId: string, response: unknown): Promise<string>;
}

export interface PasskeyDeps {
  readonly store: AuthStore;
  readonly clock: Clock;
  readonly publicOrigin: string;
  readonly allowedOrigins: ReadonlySet<string>;
  readonly lib?: WebAuthnLib;
}

interface Flow {
  readonly challenge: string;
  readonly userId: string | null;
  readonly expiresAt: number;
}

// Pending ceremonies. A flow is gone after its first verify attempt, whatever the outcome, after five minutes,
// and as the oldest once more than MAX_FLOWS wait.
function createFlows(clock: Clock) {
  const pending = new Map<string, Flow>();
  return {
    remember(challenge: string, userId: string | null): string {
      const now = clock.now();
      for (const [id, flow] of pending) if (flow.expiresAt <= now) pending.delete(id);
      while (pending.size >= MAX_FLOWS) {
        const oldest = pending.keys().next();
        if (oldest.done) break;
        pending.delete(oldest.value);
      }
      const flowId = randomToken(16);
      pending.set(flowId, { challenge, userId, expiresAt: now + FLOW_TTL_MS });
      return flowId;
    },
    take(flowId: string, userId: string | null): Flow {
      const flow = pending.get(flowId);
      pending.delete(flowId);
      if (!flow || flow.expiresAt <= clock.now() || flow.userId !== userId) {
        throw new PapError("unauthenticated");
      }
      return flow;
    },
  };
}

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
  const logins = createFlows(deps.clock);
  const requireRp = (): string => {
    if (!rpID) throw new PapError("not_found");
    return rpID;
  };
  return {
    available: rpID !== null,
    async registerOptions(userId) {
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
      return { flowId: registrations.remember(options.challenge, userId), options };
    },
    async registerVerify(userId, flowId, response) {
      const rp = requireRp();
      const flow = registrations.take(flowId, userId);
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
        transports: credential.transports ?? [],
        createdAt: deps.clock.now(),
      });
    },
    async loginOptions() {
      const rp = requireRp();
      const options = await lib.generateAuthenticationOptions({
        rpID: rp,
        userVerification: "required",
        allowCredentials: [],
      });
      return { flowId: logins.remember(options.challenge, null), options };
    },
    async loginVerify(flowId, response) {
      const rp = requireRp();
      const flow = logins.take(flowId, null);
      const id = (response as { id?: unknown } | null)?.id;
      const passkey = typeof id === "string" ? deps.store.findPasskey(id) : undefined;
      if (!passkey) throw new PapError("unauthenticated");
      const result = await attempt(() =>
        lib.verifyAuthenticationResponse({
          response: response as never,
          expectedChallenge: flow.challenge,
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
      deps.store.updatePasskeyCounter(passkey.id, result.authenticationInfo.newCounter);
      return passkey.userId;
    },
  };
}
