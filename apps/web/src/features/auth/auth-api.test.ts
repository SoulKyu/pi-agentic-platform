import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAuthStatus, login, loginWithPasskey, logout, registerPasskey, setupOwner } from "./auth-api.ts";

const webauthn = vi.hoisted(() => ({ startRegistration: vi.fn(), startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => webauthn);

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly body: unknown;
}

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const refusal = (status: number, code: string, headers?: Record<string, string>) =>
  reply(status, { error: { code } }, headers);

// Answers the requests in order and keeps what was asked, so a test reads the whole conversation.
function server(...answers: Array<Response | Error>) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      seen.push({
        method: init?.method ?? "GET",
        url,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const answer = answers.shift();
      if (!answer) throw new Error(`unexpected request to ${url}`);
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  );
  return seen;
}

const OPTIONS = { challenge: "abc" };
const authenticated = (value: boolean) =>
  reply(200, { setupRequired: false, authenticated: value, username: "ana", passkeysAvailable: true });

beforeEach(() => {
  webauthn.startRegistration.mockReset();
  webauthn.startAuthentication.mockReset();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("registerPasskey", () => {
  it("sends the password with the options request, then hands the authenticator's answer to verify", async () => {
    const seen = server(reply(200, { flowId: "f1", options: OPTIONS }), reply(200, { ok: true }));
    webauthn.startRegistration.mockResolvedValue({ id: "cred" });
    expect(await registerPasskey("correct horse battery")).toEqual({ ok: true });
    expect(webauthn.startRegistration).toHaveBeenCalledExactlyOnceWith({ optionsJSON: OPTIONS });
    expect(seen).toEqual([
      { method: "POST", url: "/auth/passkey/register/options", body: { password: "correct horse battery" } },
      {
        method: "POST",
        url: "/auth/passkey/register/verify",
        body: { flowId: "f1", response: { id: "cred" } },
      },
    ]);
  });

  it("calls a 401 a wrong password while /auth/status still says signed in", async () => {
    const seen = server(refusal(401, "unauthenticated"), authenticated(true));
    expect(await registerPasskey("nope")).toEqual({
      ok: false,
      code: "password_incorrect",
      retryAfterSeconds: null,
    });
    expect(seen.map((request) => request.url)).toEqual(["/auth/passkey/register/options", "/auth/status"]);
    expect(webauthn.startRegistration).not.toHaveBeenCalled();
  });

  it("calls a 401 an ended session when /auth/status says signed out", async () => {
    server(refusal(401, "unauthenticated"), authenticated(false));
    expect(await registerPasskey("whatever")).toEqual({
      ok: false,
      code: "unauthenticated",
      retryAfterSeconds: null,
    });
  });

  it("passes the wait of a 429 on, without asking /auth/status", async () => {
    const seen = server(refusal(429, "rate_limited", { "retry-after": "7" }));
    expect(await registerPasskey("x")).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 7 });
    expect(seen).toHaveLength(1);
  });

  it("reports offline when /auth/status cannot be reached after a 401", async () => {
    server(refusal(401, "unauthenticated"), new TypeError("Failed to fetch"));
    expect(await registerPasskey("x")).toEqual({ ok: false, code: "offline", retryAfterSeconds: null });
  });

  it("stops at the authenticator's refusal and never calls verify", async () => {
    const seen = server(reply(200, { flowId: "f1", options: OPTIONS }));
    webauthn.startRegistration.mockRejectedValue(new Error("NotAllowedError"));
    expect(await registerPasskey("x")).toEqual({
      ok: false,
      code: "passkey_cancelled",
      retryAfterSeconds: null,
    });
    expect(seen).toHaveLength(1);
  });

  it("returns the server's code when verify refuses", async () => {
    server(reply(200, { flowId: "f1", options: OPTIONS }), refusal(400, "bad_request"));
    webauthn.startRegistration.mockResolvedValue({});
    expect(await registerPasskey("x")).toMatchObject({ ok: false, code: "bad_request" });
  });
});

describe("loginWithPasskey", () => {
  it("asks for options without a password and verifies the answer", async () => {
    const seen = server(reply(200, { flowId: "chal", options: OPTIONS }), reply(200, { ok: true }));
    webauthn.startAuthentication.mockResolvedValue({ id: "cred" });
    expect(await loginWithPasskey()).toEqual({ ok: true });
    expect(webauthn.startAuthentication).toHaveBeenCalledExactlyOnceWith({ optionsJSON: OPTIONS });
    expect(seen.map((request) => [request.url, request.body])).toEqual([
      ["/auth/passkey/login/options", {}],
      ["/auth/passkey/login/verify", { flowId: "chal", response: { id: "cred" } }],
    ]);
  });

  it("does not re-check the session on a refusal of the options", async () => {
    const seen = server(refusal(401, "unauthenticated"));
    expect(await loginWithPasskey()).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(seen).toHaveLength(1);
  });

  it("reports offline instead of throwing when the network is down", async () => {
    server(new TypeError("Failed to fetch"));
    expect(await loginWithPasskey()).toEqual({ ok: false, code: "offline", retryAfterSeconds: null });
  });
});

describe("password requests", () => {
  it("setup succeeds on 201 and reports a conflict", async () => {
    const seen = server(reply(201, { ok: true }), refusal(409, "conflict"));
    expect(await setupOwner("tok", "ana", "a long enough password")).toEqual({ ok: true });
    expect(seen[0]).toEqual({
      method: "POST",
      url: "/auth/setup",
      body: { token: "tok", username: "ana", password: "a long enough password" },
    });
    expect(await setupOwner("tok", "ana", "a long enough password")).toMatchObject({ code: "conflict" });
  });

  it("login succeeds on 200, and a refusal carries its code and wait", async () => {
    server(
      reply(200, { ok: true }),
      refusal(401, "unauthenticated"),
      refusal(429, "rate_limited", { "retry-after": "3" }),
    );
    expect(await login("ana", "pw")).toEqual({ ok: true });
    expect(await login("ana", "bad")).toMatchObject({ code: "unauthenticated" });
    expect(await login("ana", "bad")).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 3 });
  });

  it("maps an unreadable error body to internal and a network failure to offline", async () => {
    server(new Response("<html>", { status: 502 }), new TypeError("Failed to fetch"));
    expect(await login("ana", "pw")).toMatchObject({ code: "internal" });
    expect(await login("ana", "pw")).toMatchObject({ code: "offline" });
  });

  it("logout swallows a network failure: /auth/status tells the truth next", async () => {
    server(new TypeError("Failed to fetch"));
    await expect(logout()).resolves.toBeUndefined();
  });

  it("reads the status, and throws when there is none", async () => {
    server(authenticated(true), reply(500, {}));
    expect(await fetchAuthStatus()).toMatchObject({ authenticated: true, username: "ana" });
    await expect(fetchAuthStatus()).rejects.toThrow("auth status unavailable");
  });
});
