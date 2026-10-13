import { z } from "zod";
import { defineMethod } from "./define.ts";
import { ApprovalMode, PolicySettings } from "./policy.ts";

const SessionId = z.string().min(1).max(128);
const Ok = z.object({ ok: z.literal(true) });
/** The revision the client read before this write; 0 creates the document (compare-and-set, owner R3-4). */
const BaseRevision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const policyMethods = {
  "policy.getSettings": defineMethod({
    name: "policy.getSettings",
    permission: "policy:read",
    idempotent: true,
    params: z.object({}),
    // null: nothing stored, or a stored value that no longer parses; the client starts from the defaults and saves over it.
    result: z.object({ value: PolicySettings.nullable(), revision: z.number().int().nonnegative() }),
    errors: [],
  }),
  "policy.setSettings": defineMethod({
    name: "policy.setSettings",
    permission: "policy:admin",
    idempotent: false,
    params: z.object({ value: PolicySettings, baseRevision: BaseRevision }),
    result: z.object({ revision: z.number().int().positive() }),
    // conflict: the stored revision is not baseRevision any more; the client re-reads, merges and retries once.
    errors: ["bad_request", "conflict"],
  }),
  "policy.setSessionMode": defineMethod({
    name: "policy.setSessionMode",
    permission: "policy:admin",
    idempotent: false,
    // null: the session follows the owner's default mode again.
    params: z.object({ sessionId: SessionId, mode: ApprovalMode.nullable() }),
    result: Ok,
    // Another owner's session is `not_found` too: existence does not leak.
    errors: ["not_found"],
  }),
  "policy.clearTaint": defineMethod({
    name: "policy.clearTaint",
    permission: "policy:admin",
    idempotent: false,
    params: z.object({ sessionId: SessionId }),
    result: Ok,
    errors: ["not_found"],
  }),
} as const;
