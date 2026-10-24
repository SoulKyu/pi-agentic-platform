import { PapError } from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultStore } from "../secrets/index.ts";
import type { AppSecretsStore } from "./app-secrets.ts";
import type { GithubClient } from "./client.ts";

/** Vault names are environment-style (`isVaultName`), so the brief's `github.user_token` is spelled in capitals. */
export const USER_TOKEN = "GITHUB_USER_TOKEN";
export const REFRESH_TOKEN = "GITHUB_REFRESH_TOKEN";
/** Expiries and the reconnect flag: not secret, kept as one small JSON entry because the vault stores no metadata. */
export const TOKEN_META = "GITHUB_TOKEN_META";
const SKEW_MS = 60_000;

const Meta = z
  .object({ expiresAt: z.number(), refreshExpiresAt: z.number(), reconnect: z.boolean() })
  .strict();
type Meta = z.infer<typeof Meta>;

const Pair = z.object({
  access_token: z.string().min(1).max(1024),
  refresh_token: z.string().min(1).max(1024),
  expires_in: z.number().positive(),
  refresh_token_expires_in: z.number().positive(),
});
const Answer = z.union([Pair, z.object({ error: z.string() })]);
type Pair = z.infer<typeof Pair>;

export type UserTokenState = "none" | "ok" | "reconnect";

export interface UserTokens {
  /** The user's access token, refreshed first (single-flight) when it is about to expire. `github_unavailable` when there is none or it needs a reconnect. */
  get(ownerId: string): Promise<string>;
  /** Stores a pair from the OAuth code exchange (the vault first). */
  store(ownerId: string, pair: Pair): void;
  state(ownerId: string): UserTokenState;
  /** Disconnect: removes the pair and its metadata. */
  clear(ownerId: string): void;
}

export function createUserTokens(deps: {
  readonly vault: VaultStore;
  readonly client: GithubClient;
  readonly appSecrets: AppSecretsStore;
  readonly clock: Clock;
  readonly logger: Logger;
}): UserTokens {
  const { vault, client, appSecrets, clock, logger } = deps;
  const scope = { kind: "user" } as const;
  const inFlight = new Map<string, Promise<string>>();

  function read(ownerId: string): { access: string; refresh: string; meta: Meta } | null {
    const values = vault.reveal(ownerId, scope);
    const access = values[USER_TOKEN];
    const refresh = values[REFRESH_TOKEN];
    const raw = values[TOKEN_META];
    if (!access || !refresh || !raw) return null;
    try {
      const meta = Meta.safeParse(JSON.parse(raw));
      return meta.success ? { access, refresh, meta: meta.data } : null;
    } catch {
      return null;
    }
  }
  function write(ownerId: string, access: string, refresh: string, meta: Meta): void {
    const now = clock.now();
    vault.set(ownerId, scope, USER_TOKEN, access, now);
    vault.set(ownerId, scope, REFRESH_TOKEN, refresh, now);
    vault.set(ownerId, scope, TOKEN_META, JSON.stringify(meta), now);
  }
  const fromPair = (pair: Pair): Meta => ({
    expiresAt: clock.now() + pair.expires_in * 1000,
    refreshExpiresAt: clock.now() + pair.refresh_token_expires_in * 1000,
    reconnect: false,
  });
  function needReconnect(ownerId: string, current: { access: string; refresh: string; meta: Meta }): never {
    write(ownerId, current.access, current.refresh, { ...current.meta, reconnect: true });
    logger.warn("github_reconnect_needed");
    throw new PapError("github_unavailable");
  }

  async function refresh(
    ownerId: string,
    current: { access: string; refresh: string; meta: Meta },
  ): Promise<string> {
    const app = appSecrets.load();
    if (!app) throw new PapError("github_unavailable");
    if (current.meta.refreshExpiresAt <= clock.now()) return needReconnect(ownerId, current);
    const answer = await client.json(Answer, {
      origin: "web",
      method: "POST",
      path: "/login/oauth/access_token",
      body: {
        client_id: app.clientId,
        client_secret: app.clientSecret,
        grant_type: "refresh_token",
        refresh_token: current.refresh,
      },
    });
    if ("error" in answer) return needReconnect(ownerId, current);
    // The new pair is in the vault before anyone uses it: the old refresh token is spent.
    write(ownerId, answer.access_token, answer.refresh_token, fromPair(answer));
    return answer.access_token;
  }

  return {
    state(ownerId) {
      const current = read(ownerId);
      if (!current) return "none";
      return current.meta.reconnect || current.meta.refreshExpiresAt <= clock.now() ? "reconnect" : "ok";
    },
    store(ownerId, pair) {
      write(ownerId, pair.access_token, pair.refresh_token, fromPair(pair));
    },
    clear(ownerId) {
      for (const name of [USER_TOKEN, REFRESH_TOKEN, TOKEN_META]) vault.remove(ownerId, scope, name);
    },
    get(ownerId) {
      const current = read(ownerId);
      if (!current || current.meta.reconnect) return Promise.reject(new PapError("github_unavailable"));
      if (current.meta.expiresAt - SKEW_MS > clock.now()) return Promise.resolve(current.access);
      const running = inFlight.get(ownerId);
      if (running) return running;
      const attempt = refresh(ownerId, current).finally(() => inFlight.delete(ownerId));
      inFlight.set(ownerId, attempt);
      return attempt;
    },
  };
}
