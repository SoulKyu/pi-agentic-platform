import { z } from "zod";
import { AGENT_EVENT_LIMITS, AGENT_LIMITS, AgentEventView, AgentInput, AgentSpendFigures } from "./agents.ts";
import { AGENT_PROMPT_LIMITS, AgentPromptName, PermissionsView, QuarantineResult } from "./agents-safety.ts";
import { TaskView, TriggerView } from "./automation-views.ts";
import { defineMethod } from "./define.ts";
import { EGRESS_UNKNOWN, EgressStatus } from "./egress.ts";
import { AGENT_GATE_ERRORS } from "./errors.ts";
import { Cursor } from "./frames.ts";
import { AgentId } from "./platform.ts";

/** What a row reads as: `unreadable` is a profile that no longer parses (listed, never started, deletable). */
export const AGENT_STATES = ["active", "paused", "quarantined", "unreadable"] as const;

/** An agent as the owner sees it (M11R43). `input` is null while the stored profile does not parse. */
export const AgentView = z
  .object({
    id: AgentId,
    name: z.string().min(1).max(AGENT_LIMITS.nameChars),
    input: AgentInput.nullable(),
    state: z.enum(AGENT_STATES),
    threadSessionId: z.string().min(1).max(128).nullable(),
    unread: z.number().int().min(0),
    paused: z.boolean(),
    quarantinedAt: z.number().int().nullable(),
    revision: z.number().int().min(1),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
  })
  .strict();
export type AgentView = z.infer<typeof AgentView>;

/** Why the sandbox cannot be used (M11R18); the probe's reasons, read by Settings › Agents. */
export const SANDBOX_REASONS = ["missing", "unsafe_path", "refused", "timeout"] as const;
/** The last probe (M11R20). `checkedAt` 0: the first probe has not ended ("checking", not "unavailable"). */
export const SandboxStatus = z
  .object({
    usable: z.boolean(),
    path: z.string().max(4096).nullable(),
    reason: z.enum(SANDBOX_REASONS).nullable(),
    checkedAt: z.number().int().min(0),
    // The egress proxy (M11R242); a view from before it existed reads as unusable.
    egress: EgressStatus.default(EGRESS_UNKNOWN),
  })
  .strict();
export type SandboxStatus = z.infer<typeof SandboxStatus>;

const Params = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** `agents.status` (M11R76): a subscription's figures are API-equivalent (DESIGN §11), `billing` says which. */
export const AgentStatus = Params({
  today: AgentSpendFigures,
  days7Usd: z.number().min(0),
  days30Usd: z.number().min(0),
  billing: z.enum(["api", "subscription", "unknown"]),
  tasks: z.array(TaskView).max(10),
  triggers: z.array(TriggerView).max(20),
  /** The triggers (or tasks) were cut to keep the frame under the page budget. */
  truncated: z.boolean(),
});
export type AgentStatus = z.infer<typeof AgentStatus>;

export const agentsMethods = {
  "agents.list": defineMethod({
    name: "agents.list",
    permission: "agents:read",
    idempotent: true,
    params: Params({}),
    result: Params({ agents: z.array(AgentView).max(AGENT_LIMITS.perOwner), truncated: z.boolean() }),
    errors: [],
  }),
  "agents.get": defineMethod({
    name: "agents.get",
    permission: "agents:read",
    idempotent: true,
    params: Params({ agentId: AgentId }),
    result: AgentView,
    errors: ["not_found"],
  }),
  // Creating asks for the password only when the agent is wider than the defaults (`widensReach`, M11R44).
  "agents.create": defineMethod({
    name: "agents.create",
    permission: "agents:admin",
    idempotent: false,
    params: Params({ input: AgentInput }),
    result: AgentView,
    errors: ["step_up_required", "limit_reached", "conflict", "bad_request", "read_only"],
  }),
  // Compare-and-set on `revision`; a widening edit asks for the password, a narrowing one or a budget does not.
  "agents.update": defineMethod({
    name: "agents.update",
    permission: "agents:admin",
    idempotent: false,
    params: Params({ agentId: AgentId, baseRevision: z.number().int().min(1), input: AgentInput }),
    result: AgentView,
    errors: ["step_up_required", "not_found", "conflict", "bad_request", "read_only"],
  }),
  // Always asks for the password. `trashedAs` names the home's entry under `agents/.trash` ("" when there was no folder).
  // `command_failed`: the home was moved but a later step failed; the agent stays quarantined and a retry finishes it.
  "agents.delete": defineMethod({
    name: "agents.delete",
    permission: "agents:admin",
    idempotent: false,
    params: Params({ agentId: AgentId }),
    result: Params({ trashedAs: z.string().max(128) }),
    errors: ["step_up_required", "not_found", "session_busy", "command_failed", "read_only"],
  }),
  // Tokens may read it (agents:read); the probe is one the daemon runs anyway.
  "agents.sandboxStatus": defineMethod({
    name: "agents.sandboxStatus",
    permission: "agents:read",
    idempotent: true,
    params: Params({}),
    result: SandboxStatus,
    errors: [],
  }),
  // Probes again now (M11R19): browser sessions only (agents:admin is outside the token permissions); at most one per 10 s.
  "agents.recheckSandbox": defineMethod({
    name: "agents.recheckSandbox",
    permission: "agents:admin",
    idempotent: true,
    params: Params({}),
    result: SandboxStatus,
    errors: ["rate_limited"],
  }),
  // The agent's one trusted thread (M11R59): the same session for every open, a new one after a reset. The launch gate
  // refuses a new thread like any agent start; a paused agent opens, a quarantined one does not.
  "agents.openThread": defineMethod({
    name: "agents.openThread",
    permission: "agents:operate",
    idempotent: false,
    params: Params({ agentId: AgentId }),
    result: Params({ sessionId: z.string().min(1).max(128) }),
    errors: ["not_found", "session_busy", "capacity", "disk_low", "worker_failed", ...AGENT_GATE_ERRORS],
  }),
  // Archives the thread (reversible from the archived list) and starts the next one fresh (M11R60); browser sessions only.
  "agents.resetThread": defineMethod({
    name: "agents.resetThread",
    permission: "agents:admin",
    idempotent: false,
    params: Params({ agentId: AgentId }),
    result: Params({}),
    errors: ["not_found", "session_busy"],
  }),
  "agents.markRead": defineMethod({
    name: "agents.markRead",
    permission: "agents:operate",
    idempotent: false,
    params: Params({ agentId: AgentId }),
    result: Params({}),
    errors: ["not_found"],
  }),
  // The thread's cards, newest first (M11R72); `before` is the `next` of the page before (its last row read, which may be a card left out as unreadable).
  "agents.events": defineMethod({
    name: "agents.events",
    permission: "agents:read",
    idempotent: true,
    params: Params({
      agentId: AgentId,
      before: Params({ at: z.number().int(), id: z.number().int().min(1) }).optional(),
    }),
    // `next` is the `before` of the following page: the last row read, a row left out as unreadable included; null when none was read.
    result: Params({
      events: z.array(AgentEventView).max(AGENT_EVENT_LIMITS.page),
      more: z.boolean(),
      next: Params({ at: z.number().int(), id: z.number().int().min(1) }).nullable(),
    }),
    errors: ["not_found"],
  }),
  // Pause is not cancel (M11R75): running tasks finish, queued ones wait. Tokens may; a resume is refused while a delete runs.
  // Resuming a quarantined agent clears the quarantine too and asks for the password (M11R115).
  // A mutation like every switch (a commandId), audited whoever calls it.
  "agents.setPaused": defineMethod({
    name: "agents.setPaused",
    permission: "agents:operate",
    idempotent: false,
    params: Params({ agentId: AgentId, paused: z.boolean() }),
    result: AgentView,
    errors: ["not_found", "conflict", "session_busy", "step_up_required", "read_only"],
  }),
  "agents.status": defineMethod({
    name: "agents.status",
    permission: "agents:read",
    idempotent: true,
    params: Params({ agentId: AgentId }),
    result: AgentStatus,
    errors: ["not_found"],
  }),
  // A thread task for the agent (M11R77): browser sessions only, a token is `forbidden`. A paused agent queues; a quarantined one does not.
  "agents.queueTask": defineMethod({
    name: "agents.queueTask",
    permission: "agents:operate",
    idempotent: false,
    params: Params({
      agentId: AgentId,
      prompt: z.string().min(1).max(AGENT_EVENT_LIMITS.queuePrompt),
      handOff: Params({
        fromAgentId: AgentId,
        quote: z.string().min(1).max(AGENT_EVENT_LIMITS.queuePrompt),
      }).optional(),
    }),
    result: Params({ taskId: z.string().min(1).max(128) }),
    errors: ["not_found", "forbidden", "agent_paused", "rate_limited", "read_only"],
  }),
  "agents.answerApproval": defineMethod({
    name: "agents.answerApproval",
    permission: "agents:operate",
    idempotent: false,
    params: Params({ requestId: z.string().min(1).max(64), approved: z.boolean() }),
    result: Params({}),
    // A token answers nothing: `forbidden` (M11R102). A closed request and another owner's are `not_found`.
    errors: ["forbidden", "not_found", "read_only"],
  }),
  "subscribe.agents": defineMethod({
    name: "subscribe.agents",
    permission: "agents:read",
    idempotent: true,
    params: Params({ after: Cursor.optional() }),
    result: z.object({ sub: z.string() }),
    errors: ["capacity"],
  }),
  // ---- Task 21 (one block, for the join): quarantine, the permissions sheet, the prompt chips ----
  // The incident playbook (M11R115): pause, cancel, archive, close, rotate, list; one step failing never stops the next.
  // The new webhook secrets are in the answer once: a replay of the command id is `conflict`. Browser sessions only.
  "agents.quarantine": defineMethod({
    name: "agents.quarantine",
    permission: "agents:admin",
    idempotent: false,
    secretResult: true,
    params: Params({ agentId: AgentId }),
    result: QuarantineResult,
    errors: ["step_up_required", "not_found", "command_failed", "conflict", "read_only"],
  }),
  // Names vault entries, so browser sessions only (agents:admin is outside the token permissions).
  "agents.permissions": defineMethod({
    name: "agents.permissions",
    permission: "agents:admin",
    idempotent: true,
    params: Params({ agentId: AgentId }),
    result: PermissionsView,
    errors: ["not_found", "forbidden"],
  }),
  // The prompt chips (M11R186): the home is agent-writable, so the text is data for the composer, never a prompt pap sends.
  "agents.prompts": defineMethod({
    name: "agents.prompts",
    permission: "agents:read",
    idempotent: true,
    params: Params({ agentId: AgentId }),
    result: Params({ names: z.array(AgentPromptName).max(AGENT_PROMPT_LIMITS.names) }),
    errors: ["not_found", "invalid_cwd"],
  }),
  "agents.prompt": defineMethod({
    name: "agents.prompt",
    permission: "agents:read",
    idempotent: true,
    params: Params({ agentId: AgentId, name: AgentPromptName }),
    result: Params({ text: z.string().max(AGENT_PROMPT_LIMITS.bytes) }),
    errors: ["not_found", "invalid_cwd", "payload_too_large", "bad_request"],
  }),
};
