import { z } from "zod";
import { defineMethod } from "./define.ts";
import {
  MEMORY_LIMITS,
  MemoryId,
  MemoryItemView,
  MemoryJournalView,
  MemoryScopeRef,
  MemoryScopeView,
  MemoryStatus,
  StagedFactView,
} from "./memory.ts";

const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

// Browser only: `memory:admin` is outside the token permissions (memories can hold private facts, MC33). `memory.status`
// says nothing about their content and stays `memory:read`.
export const memoryMethods = {
  "memory.status": defineMethod({
    name: "memory.status",
    permission: "memory:read",
    idempotent: true,
    params: Params({}),
    result: MemoryStatus,
    errors: [],
  }),
  "memory.scopes": defineMethod({
    name: "memory.scopes",
    permission: "memory:admin",
    idempotent: true,
    params: Params({}),
    result: Params({ scopes: z.array(MemoryScopeView).max(MEMORY_LIMITS.projects + 202) }),
    errors: ["forbidden"],
  }),
  "memory.list": defineMethod({
    name: "memory.list",
    permission: "memory:admin",
    idempotent: true,
    params: Params({ scope: MemoryScopeRef }),
    result: Params({
      items: z.array(MemoryItemView).max(MEMORY_LIMITS.items),
      journal: z.array(MemoryJournalView).max(MEMORY_LIMITS.journal),
    }),
    errors: ["forbidden", "not_found", "bad_request"],
  }),
  // pi-mem0 applies the request later: the answer says it was written, not that the memory is gone.
  "memory.forget": defineMethod({
    name: "memory.forget",
    permission: "memory:admin",
    idempotent: false,
    params: Params({ scope: MemoryScopeRef, ids: z.array(MemoryId).min(1).max(MEMORY_LIMITS.forgetIds) }),
    result: Params({ requested: z.number().int().min(1).max(MEMORY_LIMITS.forgetIds) }),
    errors: ["forbidden", "not_found", "bad_request", "command_failed", "read_only"],
  }),
  // Promote (a memory's text saved in `user`) or correct (`replaces`: the memory of the same scope it replaces).
  "memory.save": defineMethod({
    name: "memory.save",
    permission: "memory:admin",
    idempotent: false,
    params: Params({
      scope: MemoryScopeRef,
      text: z.string().min(1).max(MEMORY_LIMITS.textChars),
      replaces: MemoryId.optional(),
    }),
    result: Params({}),
    errors: ["forbidden", "not_found", "bad_request", "command_failed", "read_only"],
  }),
  "memory.staged": defineMethod({
    name: "memory.staged",
    permission: "memory:admin",
    idempotent: true,
    params: Params({}),
    result: Params({ facts: z.array(StagedFactView).max(MEMORY_LIMITS.staged) }),
    errors: ["forbidden"],
  }),
  // `conflict`: pi-mem0 is applying the fact right now.
  "memory.decide": defineMethod({
    name: "memory.decide",
    permission: "memory:admin",
    idempotent: false,
    params: Params({ factId: z.string().uuid(), approved: z.boolean() }),
    result: Params({}),
    errors: ["forbidden", "not_found", "conflict", "command_failed", "read_only"],
  }),
};
