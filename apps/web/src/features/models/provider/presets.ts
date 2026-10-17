import type { ProviderInput } from "@pap/contracts";

export type ProviderApi = ProviderInput["api"];
export type PresetKey =
  | "ollama"
  | "lmstudio"
  | "vllm"
  | "openrouter"
  | "openai-compatible"
  | "anthropic-compatible"
  | "gemini-compatible"
  | "custom";

/** A starter for the form (owner q2, MPR24). It only prefills fields; none of it is a Pi concept. */
export interface Preset {
  readonly key: PresetKey;
  readonly api: ProviderApi;
  readonly baseUrl: string;
  readonly auth: "none" | "stored";
  /** The product's own name, prefilled as the provider name. */
  readonly name?: string;
  /** Prefilled identifier: only for the local servers, whose id cannot clash with a built-in provider. */
  readonly id?: string;
}

export const PRESETS: readonly Preset[] = [
  {
    key: "ollama",
    api: "openai-completions",
    baseUrl: "http://localhost:11434/v1",
    auth: "none",
    name: "Ollama",
    id: "ollama",
  },
  {
    key: "lmstudio",
    api: "openai-completions",
    baseUrl: "http://localhost:1234/v1",
    auth: "none",
    name: "LM Studio",
    id: "lmstudio",
  },
  {
    key: "vllm",
    api: "openai-completions",
    baseUrl: "http://localhost:8000/v1",
    auth: "none",
    name: "vLLM",
    id: "vllm",
  },
  {
    key: "openrouter",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    auth: "stored",
    name: "OpenRouter",
  },
  { key: "openai-compatible", api: "openai-completions", baseUrl: "", auth: "stored" },
  { key: "anthropic-compatible", api: "anthropic-messages", baseUrl: "", auth: "stored" },
  { key: "gemini-compatible", api: "google-generative-ai", baseUrl: "", auth: "stored" },
  { key: "custom", api: "openai-completions", baseUrl: "", auth: "stored" },
];
