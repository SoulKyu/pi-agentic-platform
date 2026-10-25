import { z } from "zod";
import { defineMethod } from "./define.ts";
import { AGENT_GATE_ERRORS } from "./errors.ts";
import { AvailableModels } from "./models-available.ts";
import { AvailableModelsData, SessionCommandsData, ThinkingLevel, ToolPreset } from "./session-loadout.ts";

const SessionId = z.string().min(1).max(128);
const Ok = z.object({ ok: z.literal(true) });

export const sessionModelMethods = {
  "sessions.models": defineMethod({
    name: "sessions.models",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: SessionId }),
    // The session's own runtime lists them; a cold session's worker is started for it (M7R41), so capacity applies.
    result: AvailableModelsData,
    errors: ["not_found", "capacity", "worker_failed", "command_failed", "timeout", ...AGENT_GATE_ERRORS],
  }),
  /** The models a member may pick before a session exists: no `cwd`, so no host Pi helper runs (M14). */
  "sessions.availableModels": defineMethod({
    name: "sessions.availableModels",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({}).strict(),
    result: AvailableModels,
    errors: ["capacity", "timeout", "helper_failed"],
  }),
  "sessions.commands": defineMethod({
    name: "sessions.commands",
    permission: "sessions:read",
    idempotent: true,
    params: z.object({ sessionId: SessionId }),
    result: SessionCommandsData,
    errors: ["not_found", "capacity", "worker_failed", "command_failed", "timeout", ...AGENT_GATE_ERRORS],
  }),
  "sessions.setModel": defineMethod({
    name: "sessions.setModel",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({
      sessionId: SessionId,
      provider: z.string().min(1).max(128),
      modelId: z.string().min(1).max(256),
    }),
    result: Ok,
    // session_busy: a run is going on (M7R43). timeout: whether Pi switched is unknown.
    errors: [
      "not_found",
      "session_busy",
      "capacity",
      "worker_failed",
      "command_failed",
      "timeout",
      ...AGENT_GATE_ERRORS,
    ],
  }),
  "sessions.setThinking": defineMethod({
    name: "sessions.setThinking",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId, level: ThinkingLevel }),
    result: Ok,
    errors: ["not_found", "capacity", "worker_failed", "command_failed", "timeout", ...AGENT_GATE_ERRORS],
  }),
  "sessions.setTools": defineMethod({
    name: "sessions.setTools",
    permission: "sessions:operate",
    idempotent: false,
    params: z.object({ sessionId: SessionId, preset: ToolPreset }),
    result: Ok,
    // session_busy: a run is going on, so the tools of the next turn are not changed under it (M7R77). timeout: whether the worker applied it is unknown.
    errors: [
      "not_found",
      "session_busy",
      "capacity",
      "worker_failed",
      "command_failed",
      "timeout",
      ...AGENT_GATE_ERRORS,
    ],
  }),
};
