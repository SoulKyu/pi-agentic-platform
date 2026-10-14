import type { ModelsOverview, ProviderView } from "@pap/contracts";
import { settingsAccessEn, settingsAccessFr } from "../../i18n/catalog/settings-access.ts";
import { registerCatalog } from "../../i18n/index.ts";
import type { Runtime } from "../../runtime/index.ts";
import { RpcError } from "../../runtime/index.ts";
import { mount } from "../../testing/dom.ts";
import { fakeRuntime } from "../../testing/runtime-bed.ts";
import { ModelsSection } from "./ModelsSection.tsx";
import type { StepUpRunner } from "./step-up.ts";

registerCatalog({ en: settingsAccessEn, fr: settingsAccessFr });

export const current: { runtime: Runtime | undefined } = { runtime: undefined };

export const model = (provider: string, id: string, enabled: boolean) => ({
  provider,
  id,
  name: `${id} name`,
  reasoning: false,
  enabled,
});

const auth: ProviderView["auth"] = {
  oauthLabel: null,
  apiKey: true,
  configured: false,
  stored: null,
  status: "known",
  env: [],
};

const OPENAI: ProviderView = {
  id: "openai",
  name: "OpenAI",
  origin: "builtin",
  auth: { ...auth, configured: true, stored: "api_key" },
  models: [model("openai", "gpt-a", true), model("openai", "gpt-b", true)],
  modelsTruncated: false,
};

export const PROVIDERS: ProviderView[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    origin: "builtin",
    auth: {
      ...auth,
      oauthLabel: "Anthropic (Claude Pro/Max)",
      env: [
        { name: "ANTHROPIC_OAUTH_TOKEN", set: false },
        { name: "ANTHROPIC_API_KEY", set: true },
      ],
    },
    models: [model("anthropic", "claude-a", true), model("anthropic", "claude-b", false)],
    modelsTruncated: false,
  },
  OPENAI,
  {
    id: "mine",
    name: "Mine",
    origin: "models.json",
    auth: { ...auth, status: "unknown" },
    models: [],
    modelsTruncated: false,
  },
];

export const LAST_MODEL_PROVIDER: ProviderView = {
  ...OPENAI,
  models: [model("openai", "gpt-a", true)],
};

export const overviewOf = (over: Partial<ModelsOverview> = {}): ModelsOverview => ({
  providers: PROVIDERS,
  defaults: { provider: "openai", model: "gpt-a", thinkingLevel: "high" },
  enabled: { patterns: ["openai/*"], scope: "global", settingsPath: "/a/settings.json", warnings: [] },
  offline: false,
  truncated: false,
  ...over,
});

export function newBed(overview: ModelsOverview = overviewOf()) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  bed.handlers["models.overview"] = () => overview;
  return bed;
}

/** Stands in for the host's password prompt: `answer` is what the person does when asked. */
export const prompt = { answer: true, asked: 0 };
export const stepUp: StepUpRunner = async (run) => {
  try {
    return await run("stub-command");
  } catch (failure) {
    if (!(failure instanceof RpcError) || failure.code !== "step_up_required") throw failure;
    prompt.asked += 1;
    return prompt.answer ? run("stub-command") : null;
  }
};
export const show = () => mount(<ModelsSection stepUp={stepUp} />);
export const providerButton = (container: ParentNode, id: string) =>
  container.querySelector(`[data-provider="${id}"]`) as HTMLButtonElement;
export const switchOf = (container: ParentNode, label: string) =>
  [...container.querySelectorAll('[data-slot="switch"]')]
    .filter((one) => one.querySelector("label")?.textContent === label)
    .map((one) => one.querySelector('[role="switch"]') as HTMLButtonElement)[0] as HTMLButtonElement;
