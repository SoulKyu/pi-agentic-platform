import { PapError, type RepoFullName } from "@pap/contracts";
import { z } from "zod";
import type { Clock } from "../../kernel/clock.ts";
import type { AppSecretsStore } from "./app-secrets.ts";
import type { GithubClient } from "./client.ts";
import { signAppJwt } from "./jwt.ts";

export type PermissionLevel = "read" | "write";
export type Permissions = Readonly<Record<string, PermissionLevel>>;
/** What a box token may ask for: nothing else leaves the daemon (the ruling: never `administration`). */
export const BOX_PERMISSIONS: Permissions = Object.freeze({ contents: "write", pull_requests: "write" });
const INSTALLATION_TTL_MS = 10 * 60_000;
const INSTALLATIONS_MAX = 256;
const LIVE_MAX = 1024;

const Installation = z.object({ id: z.number().int().positive() });
const Minted = z.object({
  token: z.string().min(1).max(512),
  expires_at: z.string(),
  permissions: z.record(z.string(), z.string()).optional(),
  repositories: z.array(z.object({ full_name: z.string() })).optional(),
});

export interface InstallationToken {
  readonly token: string;
  readonly expiresAt: number;
}
export interface GithubTokens {
  /** The installation that reaches `repo`, from GitHub's per-repository lookup; cached ten minutes. */
  installationFor(repo: RepoFullName): Promise<number>;
  /** A token for this one repository with exactly (at most) `permissions`; anything else in the answer is refused. */
  mint(repo: RepoFullName, permissions: Permissions): Promise<InstallationToken>;
  /** An App JWT, for the calls that are the App's own. */
  appJwt(): string;
  /** Revokes an installation token at GitHub (`DELETE /installation/token`); a failure is `github_unavailable` and the caller ignores it. */
  revoke(token: string): Promise<void>;
  /** The tokens minted and not yet expired: value redaction masks them (they live in a box's `/run`). */
  liveValues(): string[];
}

export function createTokens(deps: {
  readonly client: GithubClient;
  readonly appSecrets: AppSecretsStore;
  readonly clock: Clock;
}): GithubTokens {
  const { client, appSecrets, clock } = deps;
  const installations = new Map<string, { id: number; until: number }>();
  const live = new Map<string, number>();
  const appJwt = (): string => {
    const app = appSecrets.load();
    if (!app) throw new PapError("github_unavailable");
    return signAppJwt(app.appId, app.privateKey, clock.now());
  };
  async function installationFor(repo: RepoFullName): Promise<number> {
    const hit = installations.get(repo);
    if (hit && hit.until > clock.now()) return hit.id;
    const found = await client.json(Installation, {
      path: `/repos/${repo}/installation`,
      auth: { kind: "bearer", value: appJwt() },
    });
    if (installations.size >= INSTALLATIONS_MAX) installations.clear();
    installations.set(repo, { id: found.id, until: clock.now() + INSTALLATION_TTL_MS });
    return found.id;
  }
  return {
    appJwt,
    installationFor,
    async revoke(token) {
      await client.text({
        method: "DELETE",
        path: "/installation/token",
        auth: { kind: "bearer", value: token },
      });
      live.delete(token);
    },
    liveValues() {
      for (const [token, until] of live) if (until <= clock.now()) live.delete(token);
      return [...live.keys()];
    },
    async mint(repo, permissions) {
      if ("administration" in permissions || Object.keys(permissions).length === 0)
        throw new PapError("forbidden");
      const id = await installationFor(repo);
      const name = repo.split("/")[1];
      const minted = await client.json(Minted, {
        method: "POST",
        path: `/app/installations/${id}/access_tokens`,
        auth: { kind: "bearer", value: appJwt() },
        body: { repositories: [name], permissions },
      });
      // GitHub's answer is checked against the ask: a wider grant or another repository is not used (`metadata: read` always comes along).
      const granted = minted.permissions ?? {};
      const widened = Object.entries(granted).some(
        ([key, level]) =>
          key !== "metadata" &&
          (permissions[key] === undefined || (level === "write" && permissions[key] !== "write")),
      );
      const repos = minted.repositories ?? [];
      const expiresAt = Date.parse(minted.expires_at);
      if (
        widened ||
        repos.length !== 1 ||
        repos[0]?.full_name.toLowerCase() !== repo.toLowerCase() ||
        Number.isNaN(expiresAt)
      )
        throw new PapError("forbidden");
      if (live.size >= LIVE_MAX) live.clear();
      live.set(minted.token, expiresAt);
      return { token: minted.token, expiresAt };
    },
  };
}
