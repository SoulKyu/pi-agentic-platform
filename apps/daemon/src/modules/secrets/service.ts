import { type Caller, PapError, type SecretEntry, VaultName, VaultUpdateRecord } from "@pap/contracts";
import type { Clock } from "../../kernel/clock.ts";
import type { Logger } from "../../kernel/logger.ts";
import type { AuditPort } from "../audit/index.ts";
import { VaultError, type VaultStore } from "./vault-store.ts";

export interface SecretsDeps {
  readonly vault: VaultStore;
  /** The agents registry: an agent that is not the owner's is `not_found`, and the vault of it is never touched. */
  readonly agents: { get(ownerId: string, agentId: string): unknown };
  readonly audit: Pick<AuditPort, "append">;
  /** The live workers of the agent (thread and running tasks, sandbox on); returns how many were told. */
  readonly sessions: {
    /** `sessionId` narrows the update to that one session's worker (a one-use value goes to the asking session only). */
    sendToAgent(ownerId: string, agentId: string, record: VaultUpdateRecord, sessionId?: string): number;
  };
  readonly clock: Clock;
  readonly logger: Logger;
  readonly readOnly: boolean;
}

/** Most agents whose damaged vault has been reported at once; past it the memory of reports starts over. */
const REPORTED_MAX = 1024;

export const actorOf = (caller: Caller): { actor: "user" | "token"; actorId: string } => ({
  actor: caller.kind === "token" ? "token" : "user",
  actorId: caller.credentialId.slice(0, 128),
});

export function createSecrets(deps: SecretsDeps) {
  const { vault, logger } = deps;
  const reported = new Set<string>();

  const agentOf = (ownerId: string, agentId: string): void => {
    if (!deps.agents.get(ownerId, agentId)) throw new PapError("not_found");
  };
  const writable = (): void => {
    if (deps.readOnly) throw new PapError("read_only");
  };

  /** Codes only: nothing the store or the file system said reaches a response or a log (it could hold a path or a value). */
  function refused(error: unknown, agentId: string): PapError {
    if (error instanceof PapError) return error;
    if (error instanceof VaultError) {
      // The key file is gone: said apart from an internal error (the owner restores it, or removes the vault folder).
      if (error.code === "key_lost") {
        logger.warn("vault_key_lost", { agentId });
        return new PapError("command_failed");
      }
      if (error.code === "unreadable") {
        logger.warn("vault_unreadable", { agentId });
        return new PapError("internal");
      }
      return new PapError(error.code);
    }
    logger.error("vault_failed", { agentId, code: (error as { code?: unknown } | null)?.code ?? "unknown" });
    return new PapError("internal");
  }

  /** The agent's live workers get the whole scope; a damaged one is told an empty vault, like a start (M11R86). */
  function push(ownerId: string, agentId: string): void {
    let values: Record<string, string> = {};
    try {
      values = vault.reveal(ownerId, { kind: "agent", agentId });
    } catch {
      logger.warn("vault_unreadable", { agentId });
    }
    const record = VaultUpdateRecord.safeParse({ type: "vault_update", vault: values, once: [] });
    if (!record.success) {
      logger.warn("vault_update_invalid", { agentId });
      return;
    }
    try {
      deps.sessions.sendToAgent(ownerId, agentId, record.data);
    } catch (error) {
      logger.warn("vault_update_not_sent", { agentId, err: error });
    }
  }

  function audited(caller: Caller, agentId: string, name: string, op: "set" | "delete"): void {
    deps.audit.append({
      ownerId: caller.userId,
      ...actorOf(caller),
      kind: "policy",
      reason: `secret ${op}`,
      detail: { agentId, name, op },
    });
  }

  return {
    list(caller: Caller, agentId: string): { entries: SecretEntry[]; state: "ok" | "unreadable" } {
      agentOf(caller.userId, agentId);
      try {
        return { entries: vault.names(caller.userId, { kind: "agent", agentId }), state: "ok" };
      } catch (error) {
        if (error instanceof VaultError && error.code === "unreadable")
          return { entries: [], state: "unreadable" };
        throw refused(error, agentId);
      }
    },

    set(caller: Caller, input: { agentId: string; name: string; value: string }): Record<string, never> {
      writable();
      agentOf(caller.userId, input.agentId);
      // Every write path parses the name with the contract's refinement: a refused name never reaches the store (W5-R17).
      if (!VaultName.safeParse(input.name).success) throw new PapError("bad_request");
      try {
        vault.set(
          caller.userId,
          { kind: "agent", agentId: input.agentId },
          input.name,
          input.value,
          deps.clock.now(),
        );
      } catch (error) {
        throw refused(error, input.agentId);
      }
      audited(caller, input.agentId, input.name, "set");
      push(caller.userId, input.agentId);
      return {};
    },

    remove(caller: Caller, input: { agentId: string; name: string }): Record<string, never> {
      writable();
      agentOf(caller.userId, input.agentId);
      let removed: boolean;
      try {
        removed = vault.remove(caller.userId, { kind: "agent", agentId: input.agentId }, input.name);
      } catch (error) {
        throw refused(error, input.agentId);
      }
      if (!removed) throw new PapError("not_found");
      audited(caller, input.agentId, input.name, "delete");
      push(caller.userId, input.agentId);
      return {};
    },

    /**
     * The agent's decrypted vault for a worker that starts with the sandbox on (`SessionsAgentDeps.vaultOf`). A vault
     * that cannot be opened starts the worker with an empty one and says so once per agent (M11R86).
     */
    vaultOf(ownerId: string, agentId: string): Record<string, string> {
      try {
        const values = vault.reveal(ownerId, { kind: "agent", agentId });
        reported.delete(agentId);
        return values;
      } catch {
        if (!reported.has(agentId)) {
          if (reported.size >= REPORTED_MAX) reported.clear();
          reported.add(agentId);
          logger.warn("vault_unreadable", { agentId });
        }
        return {};
      }
    },

    /** The agent was deleted: its scope goes (before its home moves). */
    drop(ownerId: string, agentId: string): void {
      vault.drop(ownerId, { kind: "agent", agentId });
      reported.delete(agentId);
    },
  };
}

export type Secrets = ReturnType<typeof createSecrets>;
