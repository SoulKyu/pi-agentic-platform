import { z } from "zod";
import { defineMethod } from "./define.ts";
import { AgentId, VAULT_CAPS, VaultName, VaultValue } from "./platform.ts";

const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** `unreadable`: the vault file or its key cannot be opened; the settings show a fixed sentence and no entry (M11R85). */
export const VAULT_STATES = ["ok", "unreadable"] as const;

/** A vault entry as the owner sees it: the name and when it was saved, never the value (M11R85). */
export const SecretEntry = Params({ name: VaultName, updatedAt: z.number().int().min(0) });
export type SecretEntry = z.infer<typeof SecretEntry>;

// Browser only: `secrets:*` is outside the token permissions. No method returns a value.
export const secretsMethods = {
  "secrets.list": defineMethod({
    name: "secrets.list",
    permission: "secrets:read",
    idempotent: true,
    params: Params({ agentId: AgentId }),
    result: Params({ entries: z.array(SecretEntry).max(VAULT_CAPS.names), state: z.enum(VAULT_STATES) }),
    errors: ["not_found"],
  }),
  // The receipt hashes the selector fields only (`agentId`, `name`), never the value (RT-03, MC30). No step-up: a secret
  // gives the agent data, not code (owner c3).
  "secrets.set": defineMethod({
    name: "secrets.set",
    permission: "secrets:admin",
    idempotent: false,
    sensitiveParams: ["agentId", "name"],
    params: Params({ agentId: AgentId, name: VaultName, value: VaultValue }),
    result: Params({}),
    errors: ["not_found", "bad_request", "limit_reached", "command_failed", "internal", "read_only"],
  }),
  "secrets.delete": defineMethod({
    name: "secrets.delete",
    permission: "secrets:admin",
    idempotent: false,
    params: Params({ agentId: AgentId, name: VaultName }),
    result: Params({}),
    errors: ["not_found", "internal", "read_only"],
  }),
  // The owner's answer to an agent's `secret_request` (M11R103). The receipt hashes `requestId` and `mode`, never the
  // value (RT-03). A token is `forbidden`; `limit_reached`: three one-use values already wait for the agent.
  "secrets.answerRequest": defineMethod({
    name: "secrets.answerRequest",
    permission: "secrets:admin",
    idempotent: false,
    sensitiveParams: ["requestId", "mode"],
    params: Params({
      requestId: z.string().min(1).max(64),
      value: VaultValue,
      mode: z.enum(["once", "vault"]),
    }),
    result: Params({}),
    errors: [
      "forbidden",
      "not_found",
      "bad_request",
      "limit_reached",
      "command_failed",
      "internal",
      "read_only",
    ],
  }),
  "secrets.declineRequest": defineMethod({
    name: "secrets.declineRequest",
    permission: "secrets:admin",
    idempotent: false,
    params: Params({ requestId: z.string().min(1).max(64) }),
    result: Params({}),
    errors: ["forbidden", "not_found", "read_only"],
  }),
};
