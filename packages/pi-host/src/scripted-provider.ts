import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { z } from "zod";

const ScriptStep = z.object({
  text: z.string().optional(),
  toolCalls: z
    .array(
      z.object({ name: z.string().min(1), args: z.record(z.string(), z.json()), id: z.string().optional() }),
    )
    .optional(),
  stopReason: z.enum(["stop", "toolUse", "error"]).optional(),
  errorMessage: z.string().optional(),
});
type ScriptStep = z.infer<typeof ScriptStep>;

export const ProviderScript = z.object({
  modelId: z.string().min(1).default("scripted"),
  steps: z.array(ScriptStep).min(1),
  /** Answer to Pi's compaction request: it is not a step, so a long session can compact without eating the script. */
  summary: z.string().min(1).optional(),
});
export type ProviderScript = z.infer<typeof ProviderScript>;

function stepMessage(step: ScriptStep) {
  const content = [
    ...(step.text === undefined ? [] : [fauxText(step.text)]),
    ...(step.toolCalls ?? []).map((call) =>
      fauxToolCall(call.name, call.args, call.id ? { id: call.id } : {}),
    ),
  ];
  const stopReason = step.stopReason ?? ((step.toolCalls?.length ?? 0) > 0 ? "toolUse" : "stop");
  return fauxAssistantMessage(content, {
    stopReason,
    ...(step.errorMessage ? { errorMessage: step.errorMessage } : {}),
  });
}

const SUMMARIZATION_PROMPT = "You are a context summarization assistant";
interface ModelCall {
  readonly messages: ReadonlyArray<{ readonly content: unknown }>;
}

/** One reply per call: the next step, or the script's summary when Pi asks for a compaction summary. */
export function scriptedReplies(script: ProviderScript): (call: ModelCall) => ReturnType<typeof stepMessage> {
  let next = 0;
  return (call) => {
    const first = call.messages[0]?.content;
    if (script.summary !== undefined && typeof first === "string" && first.startsWith(SUMMARIZATION_PROMPT))
      return fauxAssistantMessage([fauxText(script.summary)], { stopReason: "stop" });
    const step = script.steps[next++];
    if (!step) throw new Error("script exhausted");
    return stepMessage(step);
  };
}

export function buildScriptedProvider(script: ProviderScript) {
  // A fixed api id and chunk size keep runs identical: the defaults embed the clock and a random chunk size (S2).
  const faux = fauxProvider({
    api: "scripted",
    models: [{ id: script.modelId }],
    tokenSize: { min: 4, max: 4 },
  });
  if (script.summary === undefined) {
    faux.setResponses(script.steps.map((step) => () => stepMessage(step)));
  } else {
    // Summaries take slots without taking steps, so the queue is longer than the script.
    const reply = scriptedReplies(script);
    faux.setResponses(Array.from({ length: script.steps.length * 3 + 100 }, () => reply));
  }
  const model = faux.getModel(script.modelId);
  if (!model) throw new Error(`scripted model ${script.modelId} is missing`);
  return { provider: faux.provider, model };
}

export async function loadScriptedProvider(path: string) {
  return buildScriptedProvider(ProviderScript.parse(JSON.parse(await readFile(path, "utf8"))));
}
