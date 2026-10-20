import { AGENT_LIMITS, VAULT_CAPS } from "@pap/contracts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuthValues } from "./pi-auth-values.ts";
import { type KnownSecrets, MIN_SECRET_LENGTH } from "./secret-scan.ts";

/**
 * The most distinct values and the most bytes one collection holds: past either the build is refused, not truncated. Sized so a
 * full vault fits: an owner's 32 agents and the user scope hold 50 names of 4096 characters each, plus room for auth.json.
 */
const SCOPES = AGENT_LIMITS.perOwner + 1;
export const MAX_OWNER_SECRETS = SCOPES * VAULT_CAPS.names + 256;
export const MAX_OWNER_SECRET_BYTES = SCOPES * VAULT_CAPS.names * VAULT_CAPS.valueChars + 1024 * 1024;
/** Posted in the agent's thread when a cap refuses the build: the reason, not the values. */
export const OWNER_SECRETS_CAP_NOTICE =
  "Les secrets du coffre et de Pi sont trop nombreux pour être vérifiés ; l'image de l'agent n'est pas construite.";

export interface OwnerSecrets {
  readonly secrets: KnownSecrets;
  /** The providers `auth.json` knows: they get a relay entry in the image's models.json whatever the settings say. */
  readonly providers: readonly string[];
}
export type OwnerSecretsCollector = () => Promise<OwnerSecrets>;

/** Fixed words only: Pi's, the vault's and the filesystem's own messages can quote a value or a path. */
export class OwnerSecretsError extends Error {
  readonly reason: "unreadable" | "too_many";
  constructor(reason: "unreadable" | "too_many") {
    super(`the owner's secrets cannot be collected (${reason})`);
    this.name = "OwnerSecretsError";
    this.reason = reason;
  }
}

/** A code or a name that is a plain word; anything else (a message) is not said. */
function errorClass(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Za-z0-9_]{1,32}$/.test(code)) return code;
  return error instanceof Error && /^[A-Za-z]{1,32}$/.test(error.name) ? error.name : "error";
}

export interface OwnerSecretsDeps {
  readonly logger: Logger;
  /** Pi's auth.json through Pi's own storage. */
  readonly auth: () => Promise<AuthValues>;
  /** Every value of the vault (all owners, all scopes). */
  readonly vault: () => readonly string[];
  /** The Claude token, or null. */
  readonly claudeToken: () => string | null;
}

/**
 * Every string of 8 characters or more the owner keeps in `auth.json`, the vault and the Claude token (the floor is the
 * redactor's: a shorter value is not a secret pap can tell from text). Called at each build and each redactor refresh, never
 * kept; a source that fails, or a count or size past the caps, fails closed with a fixed error, and the log names the source
 * and a class or the counts, never a value.
 */
export function createOwnerSecrets(deps: OwnerSecretsDeps): OwnerSecretsCollector {
  const { logger } = deps;
  async function source<T>(name: string, read: () => T | Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      logger.warn("owner_secrets_unreadable", { source: name, err: errorClass(error) });
      throw new OwnerSecretsError("unreadable");
    }
  }
  return async () => {
    const auth = await source("auth", deps.auth);
    const vault = await source("vault", deps.vault);
    const claude = await source("claude", deps.claudeToken);
    const distinct = new Set<string>();
    for (const value of [...auth.values, ...vault, ...(claude === null ? [] : [claude])])
      if (value.length >= MIN_SECRET_LENGTH) distinct.add(value);
    let bytes = 0;
    for (const value of distinct) bytes += Buffer.byteLength(value);
    if (distinct.size > MAX_OWNER_SECRETS || bytes > MAX_OWNER_SECRET_BYTES) {
      logger.warn("owner_secrets_capped", { count: distinct.size, bytes });
      throw new OwnerSecretsError("too_many");
    }
    return { secrets: [...distinct], providers: [...new Set(auth.providers)] };
  };
}
