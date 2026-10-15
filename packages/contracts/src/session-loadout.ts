import { z } from "zod";

/** Pi's reasoning levels, lowest first (`pi-ai` `ModelThinkingLevel`). A model offers the subset its own map allows. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export const ThinkingLevel = z.enum(THINKING_LEVELS);
export type ThinkingLevel = z.infer<typeof ThinkingLevel>;

/** The tool presets of a session; `configured` is whatever Pi's own settings and extensions enable. */
export const TOOL_PRESETS = ["configured", "none", "read-only", "default", "full", "chat"] as const;
export const ToolPreset = z.enum(TOOL_PRESETS);
export type ToolPreset = z.infer<typeof ToolPreset>;

/** What the model menu shows of one model. The ids are Pi's: a worker's text is clipped before it gets here. */
export const ModelSummary = z.object({
  provider: z.string().min(1).max(128),
  id: z.string().min(1).max(256),
  name: z.string().max(256),
  reasoning: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
  images: z.boolean().optional(),
});
export type ModelSummary = z.infer<typeof ModelSummary>;

export const MAX_LOADOUT_TOOLS = 256;
export const MAX_LISTED_MODELS = 500;

/** The model, reasoning level and tools a session runs with, as its worker last said it (M7R44). */
export const SessionLoadout = z.object({
  model: ModelSummary.nullable(),
  thinkingLevel: ThinkingLevel,
  /** The levels the current model allows; a model without reasoning offers only `off` (M7R45). */
  levels: z.array(ThinkingLevel).max(THINKING_LEVELS.length),
  preset: ToolPreset,
  tools: z.array(z.string().min(1).max(256)).max(MAX_LOADOUT_TOOLS),
  toolsTruncated: z.boolean(),
  /** Whether the folder has files that need a trust decision and whether the worker opened with it `true` (M7R105); absent from older workers. */
  projectTrust: z.object({ required: z.boolean(), trusted: z.boolean() }).optional(),
  /** Whether the model's provider is paid per token (`api`) or by a subscription sign-in; absent from older workers (M10R86). */
  billing: z.enum(["api", "subscription"]).optional(),
});
export type SessionLoadout = z.infer<typeof SessionLoadout>;

const ModelRef = z.object({ provider: z.string().min(1).max(128), id: z.string().min(1).max(256) });

/** The answer of the worker's `get_available_models` and of `sessions.models`. */
export const AvailableModelsData = z.object({
  models: z.array(ModelSummary).max(MAX_LISTED_MODELS),
  /** Models were left out to stay within 500. */
  truncated: z.boolean(),
  current: ModelRef.nullable(),
});
export type AvailableModelsData = z.infer<typeof AvailableModelsData>;

export const MAX_LISTED_COMMANDS = 500;
export const COMMAND_SOURCES = ["extension", "prompt", "skill"] as const;

/** One slash command of the session's runtime. The worker clips the strings; `builtinMcp` is Pi's own `/mcp` (M7R120). */
export const SessionCommand = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(1000).nullable(),
  source: z.enum(COMMAND_SOURCES),
  builtinMcp: z.boolean(),
});
export type SessionCommand = z.infer<typeof SessionCommand>;

/** The answer of the worker's `get_commands` and of `sessions.commands`. */
export const SessionCommandsData = z.object({
  commands: z.array(SessionCommand).max(MAX_LISTED_COMMANDS),
  /** Commands were left out to stay within 500. */
  truncated: z.boolean(),
});
export type SessionCommandsData = z.infer<typeof SessionCommandsData>;
