import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  createAssistantMessageEventStream,
  createFauxCore,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type Provider,
  type ProviderAuth,
  type RegisterFauxProviderOptions,
  type StreamFunction,
} from "@earendil-works/pi-ai";
import { z } from "zod";
import { processChannel, rawChannel } from "./raw-channel.ts";

const ScriptStep = z.object({
  text: z.string().optional(),
  toolCalls: z
    .array(
      z.object({ name: z.string().min(1), args: z.record(z.string(), z.json()), id: z.string().optional() }),
    )
    .optional(),
  stopReason: z.enum(["stop", "toolUse", "error"]).optional(),
  errorMessage: z.string().optional(),
  /** Test only: `platform_call` records sent as written when the step is served, as a compromised worker would send them. */
  rawPlatformCalls: z
    .array(z.object({ op: z.string(), toolCallId: z.string().default("raw"), args: z.unknown() }))
    .max(16)
    .optional(),
});
type ScriptStep = z.infer<typeof ScriptStep>;

export const ProviderScript = z
  .object({
    modelId: z.string().min(1).default("scripted"),
    /** Test only: the main model reasons (default: it does not). */
    reasoning: z.boolean().optional(),
    /** Test only: more models of the same provider, listed after the main one, for the model menu (M7 Task 7). */
    extraModels: z
      .array(z.object({ id: z.string().min(1), reasoning: z.boolean().optional() }))
      .max(8)
      .optional(),
    /**
     * Test only: what a token costs, in dollars per million (cache reads and writes are priced as input). The faux provider
     * reports every run as free; with prices each reply carries the cost its estimated tokens come to, so a budget has
     * something to count.
     */
    prices: z
      .object({ input: z.number().min(0), output: z.number().min(0) })
      .strict()
      .optional(),
    steps: z.array(ScriptStep).min(1),
    /** Answer to Pi's compaction request: it is not a step, so a long session can compact without eating the script. */
    summary: z.string().min(1).optional(),
    /** Test only: a file to which each reply appends the system messages of the request, one JSON line per call. */
    captureSystemPrompt: z.string().min(1).optional(),
    /** Test only: a file to which each reply appends the user messages of the request, one JSON line per call. */
    captureUserMessages: z.string().min(1).optional(),
    /** Test only: a file to which each reply appends `{ model, thinking }` for the request, one JSON line per call. */
    captureThinking: z.string().min(1).optional(),
    /** Test only: a file to which each daemon answer to a raw call of a step is appended, one JSON line per answer. */
    captureRawResults: z.string().min(1).optional(),
  })
  .refine((script) => !script.extraModels?.some((extra) => extra.id === script.modelId), {
    message: "an extra model repeats the main model id",
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

let rawCount = 0;
let rawListening = false;
/** Test only: sends the step's raw `platform_call` records and appends the answers to their ids (`r1`, `r2`...) to `captureRawResults`. */
function sendRaw(script: ProviderScript, step: ScriptStep): void {
  const channel = rawChannel() ?? processChannel();
  if (!step.rawPlatformCalls || !channel) return;
  const file = script.captureRawResults;
  if (file !== undefined && !rawListening) {
    rawListening = true;
    channel.onMessage((record) => {
      if (record.type === "platform_result" && record.id.startsWith("r"))
        appendFileSync(file, `${JSON.stringify(record)}\n`);
    });
  }
  for (const call of step.rawPlatformCalls)
    channel.send({ type: "platform_call", id: `r${++rawCount}`, ...call });
}

const SUMMARIZATION_PROMPT = "You are a context summarization assistant";
interface ModelCall {
  readonly messages: ReadonlyArray<{ readonly content: unknown; readonly role?: string }>;
}
/** The request's options and the model that serves it, as the faux provider hands them to a response factory. */
interface RequestOptions {
  readonly reasoning?: string;
}
interface RequestModel {
  readonly id: string;
}

// `TranscriptContext` carries the system prompt as leading `system` messages (pi-ai `types.d.ts`).
function capture(
  script: ProviderScript,
  call: ModelCall,
  options?: RequestOptions,
  model?: RequestModel,
): void {
  if (script.captureSystemPrompt !== undefined) {
    const system = call.messages.filter((message) => message.role === "system");
    appendFileSync(script.captureSystemPrompt, `${JSON.stringify(system)}\n`);
  }
  if (script.captureUserMessages !== undefined) {
    const users = call.messages.filter((message) => message.role === "user");
    appendFileSync(script.captureUserMessages, `${JSON.stringify(users)}\n`);
  }
  // Pi passes `reasoning` only above `off`, so an absent level is the `off` one.
  if (script.captureThinking !== undefined) {
    const line = { model: model?.id ?? "", thinking: options?.reasoning ?? "off" };
    appendFileSync(script.captureThinking, `${JSON.stringify(line)}\n`);
  }
}

/** One reply per call: the next step, or the script's summary when Pi asks for a compaction summary. */
export function scriptedReplies(
  script: ProviderScript,
): (
  call: ModelCall,
  options?: RequestOptions,
  state?: unknown,
  model?: RequestModel,
) => ReturnType<typeof stepMessage> {
  let next = 0;
  return (call, options, _state, model) => {
    capture(script, call, options, model);
    const first = call.messages[0]?.content;
    if (script.summary !== undefined && typeof first === "string" && first.startsWith(SUMMARIZATION_PROMPT))
      return fauxAssistantMessage([fauxText(script.summary)], { stopReason: "stop" });
    const step = script.steps[next++];
    if (!step) throw new Error("script exhausted");
    sendRaw(script, step);
    return stepMessage(step);
  };
}

type Prices = NonNullable<ProviderScript["prices"]>;
const PER_MILLION = 1_000_000;

/** The message with the cost its usage comes to at these prices. */
function priced(message: AssistantMessage, prices: Prices): AssistantMessage {
  const { usage } = message;
  const input = (usage.input * prices.input) / PER_MILLION;
  const output = (usage.output * prices.output) / PER_MILLION;
  const cacheRead = (usage.cacheRead * prices.input) / PER_MILLION;
  const cacheWrite = (usage.cacheWrite * prices.input) / PER_MILLION;
  return {
    ...message,
    usage: {
      ...usage,
      cost: { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite },
    },
  };
}

const pricedEvent = (event: AssistantMessageEvent, prices: Prices): AssistantMessageEvent => {
  if (event.type === "done") return { ...event, message: priced(event.message, prices) };
  if (event.type === "error") return { ...event, error: priced(event.error, prices) };
  return event;
};

/** The faux provider as `fauxProvider` builds it, its streams passed through `priced` when the script has prices. */
function fauxWithPrices(options: RegisterFauxProviderOptions, prices: Prices | undefined) {
  if (prices === undefined) return fauxProvider(options);
  const core = createFauxCore(options);
  const through =
    (run: StreamFunction<string, never>): StreamFunction<string, never> =>
    (model, context, streamOptions) => {
      const inner = run(model, context, streamOptions);
      const outer = createAssistantMessageEventStream();
      void (async () => {
        for await (const event of inner) outer.push(pricedEvent(event, prices));
        outer.end(priced(await inner.result(), prices));
      })();
      return outer;
    };
  const provider = createProvider({
    id: core.provider,
    auth: { apiKey: { name: "Faux", resolve: async () => ({ auth: {} }) } },
    models: core.models,
    api: {
      stream: through(core.stream as never) as never,
      streamSimple: through(core.streamSimple as never) as never,
      fetchDeferred: core.fetchDeferred,
      cancelDeferred: core.cancelDeferred,
    },
  });
  return { provider, getModel: core.getModel, setResponses: core.setResponses };
}

export function buildScriptedProvider(script: ProviderScript) {
  // A fixed api id and chunk size keep runs identical: the defaults embed the clock and a random chunk size (S2).
  const faux = fauxWithPrices(
    {
      api: "scripted",
      models: [
        { id: script.modelId, ...(script.reasoning ? { reasoning: true } : {}) },
        ...(script.extraModels ?? []).map((extra) => ({ id: extra.id, reasoning: extra.reasoning === true })),
      ],
      tokenSize: { min: 4, max: 4 },
    },
    script.prices,
  );
  if (script.summary === undefined) {
    faux.setResponses(
      script.steps.map(
        (step) => (call: ModelCall, options?: RequestOptions, _state?: unknown, model?: RequestModel) => {
          capture(script, call, options, model);
          sendRaw(script, step);
          return stepMessage(step);
        },
      ),
    );
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

/** Test only (the helper registers it under `PAP_TEST_PROVIDER=1`): a provider whose sign-in flows need no network. */
export const SCRIPTED_AUTH_PROVIDER_ID = "scripted-auth";
export const SCRIPTED_AUTH_URL = "https://auth.scripted.test/authorize?state=scripted";

export function buildScriptedAuthProvider(): Provider {
  const faux = fauxProvider({
    api: SCRIPTED_AUTH_PROVIDER_ID,
    provider: SCRIPTED_AUTH_PROVIDER_ID,
    models: [{ id: "scripted-auth-model" }],
  });
  const auth: ProviderAuth = {
    apiKey: {
      name: "Scripted API key",
      // Asks the code first, so a test sees a key login that wants something other than a key.
      login: async (interaction) => {
        await interaction.prompt({ type: "select", message: "Region", options: [{ id: "eu", label: "EU" }] });
        return { type: "api_key", key: "unused" };
      },
      resolve: async ({ credential }) => (credential?.key ? { auth: { apiKey: credential.key } } : undefined),
    },
    oauth: {
      name: "Scripted OAuth",
      login: async (interaction) => {
        interaction.notify({
          type: "auth_url",
          url: SCRIPTED_AUTH_URL,
          instructions: "Open the link, sign in, then paste the code.",
        });
        const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
        return {
          type: "oauth",
          access: `access-${code}`,
          refresh: `refresh-${code}`,
          expires: Date.now() + 3_600_000,
        };
      },
      refresh: async (credential) => credential,
      toAuth: async (credential) => ({ apiKey: credential.access }),
    },
  };
  return { ...faux.provider, name: "Scripted (sign-in test)", auth };
}
