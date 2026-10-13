import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { getJson, postJson } from "../../runtime/index.ts";
import { clearSessionDrafts, deviceStorage } from "../../stores/drafts.ts";

export interface AuthStatus {
  readonly setupRequired: boolean;
  readonly authenticated: boolean;
  readonly username: string | null;
  readonly passkeysAvailable: boolean;
}

export type AuthResult = { ok: true } | { ok: false; code: string; retryAfterSeconds: number | null };
type ErrorBody = { error?: { code?: string } };
type Ceremony<O> = { flowId: string; options: O } & ErrorBody;

const failure = (result: { body: ErrorBody | null; retryAfterSeconds: number | null }): AuthResult => ({
  ok: false,
  code: result.body?.error?.code ?? "internal",
  retryAfterSeconds: result.retryAfterSeconds,
});
const refused = (code: string): AuthResult => ({ ok: false, code, retryAfterSeconds: null });

// A request that never got an answer (no network) is `offline`, not an exception for the screen to catch.
async function answered(run: () => Promise<AuthResult>): Promise<AuthResult> {
  try {
    return await run();
  } catch {
    return refused("offline");
  }
}

/** The status could not be read. `code` is the server's own error code when it answered with one (`read_only`...). */
export class AuthStatusError extends Error {
  readonly code: string | null;

  constructor(code: string | null) {
    super("auth status unavailable");
    this.code = code;
  }
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const result = await getJson<AuthStatus & ErrorBody>("/auth/status");
  if (result.status !== 200 || !result.body) throw new AuthStatusError(result.body?.error?.code ?? null);
  return result.body;
}

export function setupOwner(token: string, username: string, password: string): Promise<AuthResult> {
  return answered(async () => {
    const result = await postJson<ErrorBody>("/auth/setup", { token, username, password });
    return result.status === 201 ? { ok: true } : failure(result);
  });
}

export function login(username: string, password: string): Promise<AuthResult> {
  return answered(async () => {
    const result = await postJson<ErrorBody>("/auth/login", { username, password });
    return result.status === 200 ? { ok: true } : failure(result);
  });
}

export async function logout(): Promise<void> {
  try {
    await postJson("/auth/logout", {});
  } catch {
    // The caller asks /auth/status next, which tells whether the session is still there.
  } finally {
    // Whatever the server answered: no draft or pending message stays on a device the owner signed out of (R2-4).
    clearSessionDrafts(deviceStorage());
  }
}

type Stage = "options" | "verify";
type Answer = {
  readonly status: number;
  readonly body: ErrorBody | null;
  readonly retryAfterSeconds: number | null;
};

// The prompt the owner dismissed or let run out is not an error worth more than a line; anything else the
// authenticator or the browser refuses (a passkey already on this device, no matching credential...) is.
const DISMISSED = new Set(["NotAllowedError", "AbortError"]);

// Registering and signing in are the same three steps: ask the server for options, let the authenticator
// answer them, hand the answer back. Nothing is verified here: the server decides, and `refuse` words
// what it refused, per flow.
function passkeyCeremony<O>(
  flow: "register" | "login",
  optionsBody: object,
  authenticate: (options: O) => Promise<unknown>,
  refuse: (stage: Stage, answer: Answer) => Promise<AuthResult>,
): Promise<AuthResult> {
  return answered(async () => {
    const options = await postJson<Ceremony<O>>(`/auth/passkey/${flow}/options`, optionsBody);
    if (options.status !== 200 || !options.body) return refuse("options", options);
    let response: unknown;
    try {
      response = await authenticate(options.body.options);
    } catch (error) {
      return refused(
        error instanceof Error && DISMISSED.has(error.name) ? "passkey_cancelled" : "passkey_failed",
      );
    }
    const verify = await postJson<ErrorBody>(`/auth/passkey/${flow}/verify`, {
      flowId: options.body.flowId,
      response,
    });
    return verify.status === 200 ? { ok: true } : refuse("verify", verify);
  });
}

// Adding a passkey asks for the password again (R83): a stolen session alone cannot add a credential that
// outlives it. For the server a 401 is a wrong password, a verification that failed, a flow that ran out, or
// a session that ended: only /auth/status tells the last from the others.
export function registerPasskey(password: string): Promise<AuthResult> {
  return passkeyCeremony<PublicKeyCredentialCreationOptionsJSON>(
    "register",
    { password },
    (optionsJSON) => startRegistration({ optionsJSON }),
    async (stage, answer) => {
      if (answer.status !== 401 || !(await fetchAuthStatus()).authenticated) return failure(answer);
      return refused(stage === "options" ? "password_incorrect" : "passkey_failed");
    },
  );
}

// Here a 401 from verify is an assertion the server did not accept: not a wrong username or password.
export function loginWithPasskey(): Promise<AuthResult> {
  return passkeyCeremony<PublicKeyCredentialRequestOptionsJSON>(
    "login",
    {},
    (optionsJSON) => startAuthentication({ optionsJSON }),
    async (stage, answer) =>
      stage === "verify" && answer.status === 401 ? refused("passkey_failed") : failure(answer),
  );
}

export type ConfirmResult =
  | { ok: true }
  | {
      ok: false;
      code: "password_incorrect" | "rate_limited" | "unauthenticated" | "network";
      retryAfterSeconds?: number;
    };

// Step-up (M5R67): the password goes in the body of this one POST, never in a URL, a log or an RPC frame. For the
// server a 401 is a wrong password or a session that ended; only /auth/status tells which.
export async function confirmPassword(password: string): Promise<ConfirmResult> {
  try {
    const result = await postJson<ErrorBody>("/auth/confirm", { password });
    if (result.status === 204) return { ok: true };
    if (result.status === 429) {
      return {
        ok: false,
        code: "rate_limited",
        ...(result.retryAfterSeconds === null ? {} : { retryAfterSeconds: result.retryAfterSeconds }),
      };
    }
    if (result.status === 401) {
      return {
        ok: false,
        code: (await fetchAuthStatus()).authenticated ? "password_incorrect" : "unauthenticated",
      };
    }
    return { ok: false, code: "network" };
  } catch {
    return { ok: false, code: "network" };
  }
}
