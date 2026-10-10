import { readFileSync } from "node:fs";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";

export interface ScriptStep {
  text?: string;
  toolCalls?: Array<{ name: string; args: Record<string, unknown>; id?: string }>;
  stopReason?: "stop" | "toolUse" | "error";
  errorMessage?: string;
}
export interface Script {
  modelId: string;
  steps: ScriptStep[];
}

export function loadScript(path: string): Script {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Script>;
  if (!Array.isArray(parsed.steps) || parsed.steps.length === 0) throw new Error(`script ${path} has no steps`);
  return { modelId: parsed.modelId ?? "scripted", steps: parsed.steps };
}

export function buildFaux(script: Script) {
  // Fixed api id and chunk size: the defaults (`faux:<time>:<random>`, random chunk sizes) differ per run.
  const faux = fauxProvider({ api: "scripted", models: [{ id: script.modelId }], tokenSize: { min: 4, max: 4 } });
  faux.setResponses(script.steps.map((step) => () => toMessage(step)));
  return { provider: faux.provider, model: faux.getModel(script.modelId) };
}

function toMessage(step: ScriptStep) {
  const content = [
    ...(step.text === undefined ? [] : [fauxText(step.text)]),
    ...(step.toolCalls ?? []).map((call) => fauxToolCall(call.name, call.args, call.id ? { id: call.id } : {})),
  ];
  const stopReason = step.stopReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
  return fauxAssistantMessage(content, {
    stopReason,
    ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}),
  });
}
