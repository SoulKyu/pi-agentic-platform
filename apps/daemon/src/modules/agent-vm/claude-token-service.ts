import type { Caller } from "@pap/contracts";
import type { AuditPort } from "../audit/index.ts";
import type { ClaudeTokenStore } from "./claude-token.ts";

export interface ClaudeTokenService {
  set(caller: Caller, token: string): { ok: true };
  clear(caller: Caller): { ok: true };
}

/**
 * The owner's Claude token (RT-46, M6): the step-up the contract promises, one call on the store, one audit row (like
 * `models.setApiKey`'s `provider_key_set`), never the value. Registered in host and vm modes alike: the token is kept whatever
 * runtime is on, and the relay link (vm mode) hears of it through the store's listener.
 */
export function createClaudeTokenService(
  store: Pick<ClaudeTokenStore, "set" | "clear">,
  /** The owner's password was confirmed lately (`step_up_required` otherwise): like `models.setApiKey`, the browser only. */
  requireStepUp: (caller: Caller) => void,
  audit: Pick<AuditPort, "append">,
): ClaudeTokenService {
  const record = (caller: Caller, reason: "claude_token_set" | "claude_token_cleared"): void =>
    audit.append({ ownerId: caller.userId, actor: "user", kind: "auth", reason });
  return {
    set(caller, token) {
      requireStepUp(caller);
      store.set(token);
      record(caller, "claude_token_set");
      return { ok: true };
    },
    clear(caller) {
      requireStepUp(caller);
      store.clear();
      record(caller, "claude_token_cleared");
      return { ok: true };
    },
  };
}
