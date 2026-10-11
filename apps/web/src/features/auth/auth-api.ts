import {
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/browser";
import { getJson, postJson, type HttpResult } from "../../runtime/index.ts";

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

export async function fetchAuthStatus(): Promise<AuthStatus> {
  const result = await getJson<AuthStatus>("/auth/status");
  if (result.status !== 200 || !result.body) throw new Error("auth status unavailable");
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
  }
}

// Registering and signing in are the same three steps: ask the server for options, let the authenticator
// answer them, hand the answer back. Nothing is verified here: the server decides.
function passkeyCeremony<O>(
  flow: "register" | "login",
  optionsBody: object,
  authenticate: (options: O) => Promise<unknown>,
  refuseOptions: (options: HttpResult<Ceremony<O>>) => Promise<AuthResult>,
): Promise<AuthResult> {
  return answered(async () => {
    const options = await postJson<Ceremony<O>>(`/auth/passkey/${flow}/options`, optionsBody);
    if (options.status !== 200 || !options.body) return refuseOptions(options);
    let response: unknown;
    try {
      response = await authenticate(options.body.options);
    } catch {
      return refused("passkey_cancelled");
    }
    const verify = await postJson<ErrorBody>(`/auth/passkey/${flow}/verify`, {
      flowId: options.body.flowId,
      response,
    });
    return verify.status === 200 ? { ok: true } : failure(verify);
  });
}

// Adding a passkey asks for the password again (R83): a stolen session alone cannot add a credential that
// outlives it. A 401 means a wrong password or a session that ended, and only /auth/status tells which.
export function registerPasskey(password: string): Promise<AuthResult> {
  return passkeyCeremony<PublicKeyCredentialCreationOptionsJSON>(
    "register",
    { password },
    (optionsJSON) => startRegistration({ optionsJSON }),
    async (options) => {
      if (options.status !== 401) return failure(options);
      return (await fetchAuthStatus()).authenticated ? refused("password_incorrect") : failure(options);
    },
  );
}

export function loginWithPasskey(): Promise<AuthResult> {
  return passkeyCeremony<PublicKeyCredentialRequestOptionsJSON>(
    "login",
    {},
    (optionsJSON) => startAuthentication({ optionsJSON }),
    async (options) => failure(options),
  );
}
