import { PapError, type Caller, type GithubStatusView } from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { requireStepUp } from "../auth/index.ts";
import type { GithubCore } from "./index.ts";
import { appName, buildManifest } from "./manifest.ts";
import { assertBrowserCaller } from "./browser-only.ts";

const CODE = /^[A-Za-z0-9_-]{1,128}$/;
const Conversion = z.object({
  id: z.number().int().positive(),
  slug: z.string().min(1).max(256),
  client_id: z.string().min(1).max(256),
  client_secret: z.string().min(1).max(512),
  pem: z.string().min(1).max(8192),
  html_url: z.string().url().max(2048),
});
const Exchange = z.union([
  z.object({
    access_token: z.string().min(1).max(1024),
    refresh_token: z.string().min(1).max(1024),
    expires_in: z.number().positive(),
    refresh_token_expires_in: z.number().positive(),
  }),
  z.object({ error: z.string() }),
]);
const Login = z.object({ login: z.string().min(1).max(256) });

const codeOf = (error: unknown): string => (error instanceof PapError ? error.code : "error");

export interface ManifestStart {
  /** The state GitHub sends back to `/github/app/created`. */
  readonly state: string;
  readonly manifest: string;
}
/** What a callback page needs. `home` is where the link back into pap points; null when the callback proved nothing. */
export type CallbackOutcome =
  | {
      readonly kind: "created";
      readonly slug: string;
      readonly permissionsUrl: string;
      readonly installUrl: string;
      readonly installationsUrl: string;
      readonly home: string;
    }
  | { readonly kind: "authorized"; readonly home: string }
  | { readonly kind: "refused" }
  | { readonly kind: "github"; readonly home: string | null };

export interface GithubService {
  status(caller: Caller, origin: string | undefined): Promise<GithubStatusView>;
  startCreate(
    caller: Caller,
    origin: string | undefined,
  ): { postUrl: string; manifest: string; state: string };
  /** The GitHub sign-in URL; `origin` (the WebSocket's, checked against the allowed origins) is where GitHub sends the browser back. */
  authorizeUrl(caller: Caller, origin: string | undefined): string;
  disconnect(caller: Caller): void;
  forget(caller: Caller): void;
  /** B3 sets it when the key upload is refused for a missing permission; a reconnect or a forget clears it. */
  setPermissionMissing(value: boolean): void;
  /** `GET /github/app/new`: the state a cookie-bearing owner started with, spent for a fresh one GitHub will return. */
  beginCreate(userId: string, state: string): ManifestStart | null;
  completeCreate(code: string, state: string): Promise<CallbackOutcome>;
  completeAuthorize(code: string, state: string): Promise<CallbackOutcome>;
  /** `GET /github/app/authorize`: the GitHub URL to sign in at (back to the App's own origin), or null without an App. */
  reconnectUrl(userId: string): string | null;
  readonly webOrigin: string;
}

export interface GithubServiceDeps {
  readonly core: GithubCore;
  readonly audit: Pick<AuditPort, "append">;
  readonly clock: Clock;
  readonly logger: Logger;
  /** The host's first name part, for the App's name. */
  readonly hostLabel: string;
  /** The origins pap answers to: the App's callbacks are never built on any other. */
  readonly allowedOrigins: ReadonlySet<string>;
}

export function createGithubService(deps: GithubServiceDeps): GithubService {
  const { core, audit, clock, logger } = deps;
  const { client, appSecrets, userTokens, states } = core;
  const logins = new Map<string, string>();
  let permissionMissing = false;

  const record = (ownerId: string, reason: string): void =>
    audit.append({ ownerId, actor: "user", kind: "auth", reason });
  const callbackOf = (origin: string): string => `${origin}/github/app/authorized`;
  /** The sign-in URL; GitHub returns the browser to `origin` (the caller's, else the App's own), which must be a registered callback. */
  const authorizeUrlOf = (userId: string, origin?: string): string | null => {
    const app = appSecrets.load();
    if (!app) return null;
    const back = origin ?? app.callbackOrigin;
    const query = new URLSearchParams({
      client_id: app.clientId,
      redirect_uri: callbackOf(back),
      state: states.issue(userId, "authorize", back),
    });
    return `${client.webOrigin}/login/oauth/authorize?${query.toString()}`;
  };
  async function loginOf(ownerId: string): Promise<string | null> {
    const known = logins.get(ownerId);
    if (known) return known;
    try {
      const token = await userTokens.get(ownerId);
      const { login } = await client.json(Login, { path: "/user", auth: { kind: "bearer", value: token } });
      logins.set(ownerId, login);
      return login;
    } catch (error) {
      logger.warn("github_login_unavailable", { code: codeOf(error) });
      return null;
    }
  }
  const forgetUser = (ownerId: string): void => {
    userTokens.clear(ownerId);
    logins.delete(ownerId);
    permissionMissing = false;
  };

  return {
    webOrigin: client.webOrigin,
    setPermissionMissing(value) {
      permissionMissing = value;
    },
    async status(caller, origin) {
      assertBrowserCaller("github.status", caller);
      const app = appSecrets.status();
      if (!app) return { state: "absent", app: null, login: null, permissionMissing: false };
      const { authorizedOrigins, ...shown } = app;
      const tokens = userTokens.state(caller.userId);
      const state = tokens === "none" ? "created" : tokens === "ok" ? "connected" : "reconnect";
      return {
        state,
        app: {
          ...shown,
          // An origin GitHub once accepted as the sign-in callback is registered: the notice clears.
          originMatches:
            origin === undefined || origin === app.callbackOrigin || authorizedOrigins.includes(origin),
        },
        login: state === "connected" ? await loginOf(caller.userId) : null,
        permissionMissing: state === "connected" && permissionMissing,
      };
    },
    startCreate(caller, origin) {
      assertBrowserCaller("github.startCreate", caller);
      if (origin === undefined) throw new PapError("internal");
      if (!deps.allowedOrigins.has(origin)) throw new PapError("forbidden");
      if (appSecrets.load()) throw new PapError("conflict");
      const state = states.issue(caller.userId, "create", origin);
      return {
        postUrl: `${origin}/github/app/new?state=${state}`,
        manifest: buildManifest(origin, appName(deps.hostLabel)),
        state,
      };
    },
    authorizeUrl(caller, origin) {
      assertBrowserCaller("github.authorizeUrl", caller);
      if (origin !== undefined && !deps.allowedOrigins.has(origin)) throw new PapError("forbidden");
      const url = authorizeUrlOf(caller.userId, origin);
      if (url === null) throw new PapError("github_unavailable");
      return url;
    },
    disconnect(caller) {
      assertBrowserCaller("github.disconnect", caller);
      forgetUser(caller.userId);
      record(caller.userId, "github_disconnected");
    },
    forget(caller) {
      assertBrowserCaller("github.forget", caller);
      requireStepUp(caller, clock.now());
      appSecrets.forget();
      states.clear();
      forgetUser(caller.userId);
      record(caller.userId, "github_forgotten");
    },
    beginCreate(userId, state) {
      const claimed = states.claim(state, userId, "create");
      if (!claimed || claimed.data === null || appSecrets.load()) return null;
      const origin = claimed.data;
      return {
        state: states.issue(userId, "created", origin),
        manifest: buildManifest(origin, appName(deps.hostLabel)),
      };
    },
    reconnectUrl: (userId) => authorizeUrlOf(userId),
    async completeCreate(code, state) {
      const entry = states.take(state, "created");
      if (!entry || entry.data === null || !CODE.test(code) || appSecrets.load()) return { kind: "refused" };
      const origin = entry.data;
      let slug: string;
      let htmlUrl: string;
      try {
        const made = await client.json(Conversion, {
          method: "POST",
          path: `/app-manifests/${code}/conversions`,
        });
        if (!made.html_url.startsWith(`${client.webOrigin}/`)) return { kind: "github", home: null };
        if (appSecrets.load()) return { kind: "refused" }; // another valid state won while this one waited
        slug = made.slug;
        htmlUrl = made.html_url;
        appSecrets.save({
          appId: made.id,
          slug: made.slug,
          clientId: made.client_id,
          clientSecret: made.client_secret,
          privateKey: made.pem,
          htmlUrl: made.html_url,
          callbackOrigin: origin,
        });
      } catch (error) {
        logger.warn("github_create_failed", { code: codeOf(error) });
        return { kind: "github", home: null };
      }
      record(entry.userId, "github_app_created");
      return {
        kind: "created",
        slug,
        // The App's settings live under /settings/apps/<slug>; /apps/<slug> is its public page.
        permissionsUrl: `${client.webOrigin}/settings/apps/${encodeURIComponent(slug)}/permissions`,
        installUrl: `${htmlUrl}/installations/new?state=${states.issue(entry.userId, "authorize", origin)}`,
        installationsUrl: `${client.webOrigin}/settings/installations`,
        home: `${origin}/`,
      };
    },
    async completeAuthorize(code, state) {
      const entry = states.take(state, "authorize");
      const app = appSecrets.load();
      if (!entry || !app || !CODE.test(code)) return { kind: "refused" };
      // The origin the sign-in started at (checked against the allowed origins then); a state without one is the App's own.
      const origin = entry.data ?? app.callbackOrigin;
      if (origin !== app.callbackOrigin && !deps.allowedOrigins.has(origin)) return { kind: "refused" };
      const home = `${origin}/`;
      try {
        const answer = await client.json(Exchange, {
          origin: "web",
          method: "POST",
          path: "/login/oauth/access_token",
          body: {
            client_id: app.clientId,
            client_secret: app.clientSecret,
            code,
            redirect_uri: callbackOf(origin),
          },
        });
        if ("error" in answer) return { kind: "github", home };
        userTokens.store(entry.userId, answer);
        // GitHub accepted this origin as a callback: the mismatch notice has nothing left to say about it.
        if (origin !== app.callbackOrigin) appSecrets.addAuthorizedOrigin(origin);
      } catch (error) {
        logger.warn("github_authorize_failed", { code: codeOf(error) });
        return { kind: "github", home };
      }
      logins.delete(entry.userId);
      permissionMissing = false;
      record(entry.userId, "github_authorized");
      return { kind: "authorized", home };
    },
  };
}
