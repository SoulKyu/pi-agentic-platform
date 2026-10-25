import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { PapError } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { VaultStore } from "../secrets/index.ts";
import { CLAUDE_TOKEN_FILE, errorClass, readLegacyTokenFile } from "./claude-token.ts";

/** The name of a user's `claude setup-token` value in the vault's user scope (vault names are environment-style). */
export const CLAUDE_TOKEN_NAME = "CLAUDE_TOKEN";
const scope = { kind: "user" } as const;

/** What the vault holds for a user: a vault that cannot be read is its own state, never "missing" (M14, A4a review M4). */
export type ClaudeTokenRead =
  | { readonly state: "set"; readonly token: string }
  | { readonly state: "missing" }
  | { readonly state: "unreadable" };

export interface ClaudeTokens {
  /** The vault's answer for the user, the cause of a failure said once in the log (by class only) until the vault reads again. */
  read(ownerId: string): ClaudeTokenRead;
  /** The user's token, or null: none, or a vault that cannot be opened (`read` tells the two apart). */
  get(ownerId: string): string | null;
  set(ownerId: string, token: string): void;
  clear(ownerId: string): void;
  /** `set` or `missing`, never the value (RT-46). */
  status(ownerId: string): "set" | "missing";
  /** Called with the user whose token changed, after a `set` or a `clear`: the relay link refreshes the boxes. */
  onChange(listener: (ownerId: string) => void): () => void;
  /**
   * M14 (RT-18): the legacy install-wide file moves into the owner's vault and goes. No owner yet: the file stays. A vault that
   * already holds the token wins (a crash left both) and the file goes. A vault that cannot be read keeps the file.
   */
  migrateLegacy(ownerId: string | null): void;
}

/** A vault failure by its code (`vault: key_lost`), never a value or a path. */
const vaultClass = (error: unknown): string =>
  error instanceof Error && error.name === "VaultError" ? error.message : errorClass(error);

/**
 * Each user's Claude token (R13, RT-46), sealed in the vault's user scope under `CLAUDE_TOKEN`: a user's box is served with
 * that user's token and nobody else's. It never reaches a log line, a status or an error: only fixed words and classes do.
 */
export function createClaudeTokens(deps: {
  readonly vault: VaultStore;
  readonly clock: Pick<Clock, "now">;
  readonly logger: Logger;
  readonly secretsDir: string;
}): ClaudeTokens {
  const { vault, clock, logger, secretsDir } = deps;
  const listeners = new Set<(ownerId: string) => void>();
  const tell = (ownerId: string): void => {
    for (const listener of listeners) {
      try {
        listener(ownerId);
      } catch (error) {
        logger.warn("claude_token_listener_failed", { err: errorClass(error) });
      }
    }
  };
  // Users whose unreadable vault was already said: one warning per episode, not one per policy push.
  const said = new Set<string>();
  const read = (ownerId: string): ClaudeTokenRead => {
    try {
      const token = vault.reveal(ownerId, scope)[CLAUDE_TOKEN_NAME];
      said.delete(ownerId);
      return token === undefined ? { state: "missing" } : { state: "set", token };
    } catch (error) {
      if (!said.has(ownerId)) logger.warn("claude_token_unreadable", { err: vaultClass(error) });
      said.add(ownerId);
      return { state: "unreadable" };
    }
  };
  const get = (ownerId: string): string | null => {
    const answer = read(ownerId);
    return answer.state === "set" ? answer.token : null;
  };
  return {
    read,
    get,
    // The wire status has no word for an unreadable vault yet: it reads "missing" there, and `read` tells the two apart for a caller that can show it.
    status: (ownerId) => (get(ownerId) === null ? "missing" : "set"),
    set(ownerId, token) {
      try {
        vault.set(ownerId, scope, CLAUDE_TOKEN_NAME, token, clock.now());
      } catch (error) {
        logger.error("claude_token_write_failed", { err: vaultClass(error) });
        throw new PapError("internal");
      }
      logger.info("claude_token_set");
      tell(ownerId);
    },
    clear(ownerId) {
      try {
        vault.remove(ownerId, scope, CLAUDE_TOKEN_NAME);
      } catch (error) {
        logger.error("claude_token_clear_failed", { err: vaultClass(error) });
        throw new PapError("internal");
      }
      logger.info("claude_token_cleared");
      tell(ownerId);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    migrateLegacy(ownerId) {
      if (ownerId === null) return;
      const path = join(secretsDir, CLAUDE_TOKEN_FILE);
      const legacy = readLegacyTokenFile(path, (reason) => {
        logger.warn("claude_token_legacy_unreadable", { err: reason });
        return null;
      });
      if (legacy === null) return;
      try {
        if (vault.reveal(ownerId, scope)[CLAUDE_TOKEN_NAME] === undefined)
          vault.set(ownerId, scope, CLAUDE_TOKEN_NAME, legacy, clock.now());
      } catch (error) {
        logger.warn("claude_token_migration_kept", { err: vaultClass(error) });
        return;
      }
      try {
        unlinkSync(path);
      } catch (error) {
        logger.warn("claude_token_legacy_not_removed", { err: errorClass(error) });
        return;
      }
      logger.info("claude_token_migrated");
    },
  };
}
