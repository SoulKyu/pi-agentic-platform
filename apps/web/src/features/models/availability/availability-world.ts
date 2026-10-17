import type { ModelsOverview, ProviderView } from "@pap/contracts";
import type { Runtime } from "../../../runtime/index.ts";
import { fakeRuntime } from "../../../testing/runtime-bed.ts";

export const current: { runtime: Runtime | undefined } = { runtime: undefined };

const auth = (configured: boolean): ProviderView["auth"] => ({
  oauthLabel: null,
  apiKey: true,
  configured,
  stored: configured ? "api_key" : null,
  status: "known",
  env: [],
});

const provider = (
  id: string,
  name: string,
  configured: boolean,
  models: readonly string[],
  origin: ProviderView["origin"] = "builtin",
): ProviderView => ({
  id,
  name,
  origin,
  auth: auth(configured),
  models: models.map((model) => ({
    provider: id,
    id: model,
    name: `${model} name`,
    reasoning: false,
    enabled: true,
  })),
  modelsTruncated: false,
});

export const BASE: readonly ProviderView[] = [
  provider("openai", "OpenAI", true, ["gpt-a", "gpt-b"]),
  provider("anthropic", "Anthropic", false, ["claude-a", "claude-b"]),
  provider("mine", "Mine", true, ["m1"], "models.json"),
];

export interface World {
  providers: readonly ProviderView[];
  /** `provider/id` of every model that is on; null: no list (every model is on). */
  selected: Set<string> | null;
  /** Patterns of the list that match nothing. */
  dead: string[];
  scope: "global" | "project";
  /** The overview's own `truncated` flag: the provider list is cut short. */
  truncated?: boolean;
}

export const allKeys = (providers: readonly ProviderView[]): string[] =>
  providers.flatMap((one) => one.models.map((model) => `${one.id}/${model.id}`));

export function overviewOfWorld(world: World): ModelsOverview {
  const patterns = world.selected === null ? null : [...world.selected, ...world.dead];
  return {
    providers: world.providers.map((one) => ({
      ...one,
      models: one.models.map((model) => ({
        ...model,
        enabled: world.selected === null || world.selected.has(`${one.id}/${model.id}`),
      })),
    })),
    defaults: { provider: null, model: null, thinkingLevel: null },
    enabled: {
      patterns,
      scope: world.scope,
      settingsPath: "/work/.pi/settings.json",
      warnings: world.dead.map((pattern) => `No model matches "${pattern}".`),
    },
    offline: false,
    truncated: world.truncated ?? false,
  };
}

export function availableOfWorld(world: World) {
  const view = overviewOfWorld(world);
  const connected = view.providers.filter((one) => one.auth.configured);
  return {
    models: connected.flatMap((one) =>
      one.models
        .filter((model) => model.enabled)
        .map(({ provider: from, id, name, reasoning }) => ({ provider: from, id, name, reasoning })),
    ),
    providers: connected.map((one) => ({ id: one.id, name: one.name })),
    origin: world.selected === null ? "signed-in" : "scope",
    truncated: false,
  };
}

function apply(world: World, op: Record<string, unknown>): void {
  if (op.op === "clear") {
    world.selected = null;
    world.dead = [];
    return;
  }
  if (op.op === "prune") {
    world.dead = [];
    return;
  }
  const on = world.selected ?? new Set(allKeys(world.providers));
  if (op.op === "toggle") {
    const key = `${String(op.provider)}/${String(op.modelId)}`;
    if (op.enabled === true) on.add(key);
    else on.delete(key);
  }
  if (op.op === "provider") {
    const one = world.providers.find((candidate) => candidate.id === op.provider);
    for (const model of one?.models ?? []) {
      const key = `${String(op.provider)}/${model.id}`;
      if (op.enabled === true) on.add(key);
      else on.delete(key);
    }
  }
  world.selected = on;
}

/** A fake daemon for the section: overview, available and setEnabled share one world. */
export function availabilityBed(over: Partial<World> = {}) {
  const bed = fakeRuntime();
  current.runtime = bed.runtime;
  const world: World = {
    providers: BASE,
    selected: new Set(["openai/gpt-a", "mine/m1"]),
    dead: [],
    scope: "global",
    ...over,
  };
  bed.handlers["models.overview"] = () => overviewOfWorld(world);
  bed.handlers["models.available"] = () => availableOfWorld(world);
  bed.handlers["models.setEnabled"] = (params) => {
    apply(world, (params as { op: Record<string, unknown> }).op);
    return { patterns: world.selected === null ? null : [...world.selected] };
  };
  return { bed, world };
}
