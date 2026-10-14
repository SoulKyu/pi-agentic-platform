import { resolveModelScopeWithDiagnostics, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { ENABLED_PATTERN_MAX_LENGTH, ENABLED_PATTERNS_MAX, HELPER_OPS, type EnabledOp } from "@pap/contracts";
import type { z } from "zod";
import { defineOp, type HelperOp, HelperOpError } from "../ops.ts";
import { commit, settingsToWrite } from "./models-defaults.ts";
import { guardSettingsWrite, openRuntime } from "./models-open.ts";

export type { EnabledOp };

export interface CatalogModel {
  readonly provider: string;
  readonly id: string;
  readonly name?: string;
}
/** Every model Pi knows (signed in or not): the planner reads nothing else. */
export interface CatalogFacts {
  readonly models: readonly CatalogModel[];
}
export type EnabledPlan =
  | { patterns: string[] | undefined }
  /** `last-model`: nothing would stay enabled. `too-large`: the list would not fit the contract's bounds. */
  | { refused: "last-model" | "too-large" };

/** The plan did not resolve, in Pi's own matching, to what was intended: nothing is written (fail closed). */
export class PlanMismatch extends Error {
  constructor() {
    super("enabledModels plan does not resolve as intended");
    this.name = "PlanMismatch";
  }
}

const keyOf = (model: CatalogModel) => `${model.provider}/${model.id}`;
export const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((v, i) => v === b[i]));

/** key -> thinking level the entry gives it. */
type Cover = ReadonlyMap<string, string | undefined>;
interface Entry {
  readonly text: string;
  readonly cover: Cover;
  readonly level: string | undefined;
}

function makePlanner(catalog: CatalogFacts) {
  const view = { getAvailable: async () => catalog.models } as unknown as ModelRuntime;
  const everyKey = catalog.models.map(keyOf);
  const providerKeys = new Map<string, string[]>();
  for (const model of catalog.models) {
    const keys = providerKeys.get(model.provider) ?? [];
    keys.push(keyOf(model));
    providerKeys.set(model.provider, keys);
  }

  /** Pi's own matching (M7R54): never a string comparison of patterns. */
  async function resolve(patterns: readonly string[]): Promise<Cover> {
    const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], view);
    return new Map(scopedModels.map(({ model, thinkingLevel }) => [keyOf(model), thinkingLevel]));
  }
  const analyse = (list: readonly string[]): Promise<Entry[]> =>
    Promise.all(
      list.map(async (text) => {
        const cover = await resolve([text]);
        return { text, cover, level: [...cover.values()][0] };
      }),
    );
  /** A list that enables no model leaves the scope off: every model is enabled (Pi's `scopedModels` is empty). */
  const effective = (cover: Cover): Set<string> =>
    cover.size === 0 ? new Set(everyKey) : new Set(cover.keys());
  const unchanged = (current: readonly string[] | undefined): EnabledPlan => ({
    patterns: current === undefined ? undefined : [...current],
  });

  /** The glob that matches exactly this provider's models (nested ids need the double star), or null. */
  async function exactGlob(provider: string, keys: readonly string[]): Promise<string | null> {
    for (const glob of [`${provider}/*`, `${provider}/**`]) {
      const cover = await resolve([glob]);
      if (cover.size === keys.length && keys.every((key) => cover.has(key))) return glob;
    }
    return null;
  }

  /** Writes `list` only after Pi's own matching says it enables exactly `expected`. */
  async function settle(
    list: string[],
    expected: ReadonlySet<string>,
    current: readonly string[] | undefined,
  ): Promise<EnabledPlan> {
    if (same(list, current)) return unchanged(current);
    if (list.length > ENABLED_PATTERNS_MAX || list.some((text) => text.length > ENABLED_PATTERN_MAX_LENGTH))
      return { refused: "too-large" };
    const now = effective(await resolve(list));
    if (now.size !== expected.size || [...expected].some((key) => !now.has(key))) throw new PlanMismatch();
    return { patterns: list };
  }

  /** Every model but `remove`, as little text as is exact: a glob for an untouched provider, else model by model. */
  async function allExcept(remove: ReadonlySet<string>): Promise<string[]> {
    const out: string[] = [];
    for (const [provider, keys] of providerKeys) {
      const rest = keys.filter((key) => !remove.has(key));
      if (rest.length === 0) continue;
      const glob = rest.length === keys.length && keys.length >= 2 ? await exactGlob(provider, keys) : null;
      if (glob) out.push(glob);
      else out.push(...rest);
    }
    return out;
  }

  async function disable(list: readonly string[], remove: ReadonlySet<string>): Promise<EnabledPlan> {
    const entries = await analyse(list);
    const before = effective(new Map(entries.flatMap((entry) => [...entry.cover])));
    if (![...remove].some((key) => before.has(key))) return unchanged(list);
    const expected = new Set([...before].filter((key) => !remove.has(key)));
    if (expected.size === 0) return { refused: "last-model" };
    let out: string[];
    if (entries.every((entry) => entry.cover.size === 0)) out = [...list, ...(await allExcept(remove))];
    else {
      out = [];
      for (const entry of entries) {
        if (![...entry.cover.keys()].some((key) => remove.has(key))) {
          out.push(entry.text);
          continue;
        }
        // Only the entry that covers a switched-off model is rewritten, in place, keeping its thinking level.
        for (const key of entry.cover.keys()) {
          const text = entry.level === undefined ? key : `${key}:${entry.level}`;
          if (!remove.has(key) && !out.includes(text)) out.push(text);
        }
      }
    }
    return settle(out, expected, list);
  }

  /** Two or more exact entries that together are one whole provider become that provider's glob, when it is exact. */
  async function collapse(list: string[], provider: string): Promise<string[]> {
    const keys = providerKeys.get(provider);
    if (!keys) return list;
    const entries = await analyse(list);
    const own = new Set(keys);
    const owned = entries.filter(
      (entry) => entry.cover.size > 0 && [...entry.cover.keys()].every((key) => own.has(key)),
    );
    if (owned.length < 2 || owned.some((entry) => entry.level !== undefined)) return list;
    if (!keys.every((key) => owned.some((entry) => entry.cover.has(key)))) return list;
    const glob = await exactGlob(provider, keys);
    if (glob === null) return list;
    const out: string[] = [];
    for (const entry of entries) {
      if (!owned.includes(entry)) out.push(entry.text);
      else if (!out.includes(glob)) out.push(glob);
    }
    return out;
  }

  async function enable(
    list: readonly string[],
    keys: readonly string[],
    provider: string,
  ): Promise<EnabledPlan> {
    const entries = await analyse(list);
    const scoped = new Set(entries.flatMap((entry) => [...entry.cover.keys()]));
    if (scoped.size === 0) return unchanged(list);
    const missing = keys.filter((key) => !scoped.has(key));
    const out = await collapse([...list, ...missing], provider);
    return settle(out, new Set([...scoped, ...keys]), list);
  }

  async function prune(list: readonly string[]): Promise<EnabledPlan> {
    const kept = (await analyse(list)).filter((entry) => entry.cover.size > 0).map((entry) => entry.text);
    if (kept.length === list.length) return unchanged(list);
    return { patterns: kept.length === 0 ? undefined : kept };
  }

  async function resync(list: readonly string[], providers: readonly string[]): Promise<EnabledPlan> {
    let plan: EnabledPlan = unchanged(list);
    for (const provider of providers) {
      const keys = providerKeys.get(provider);
      if (!keys || !("patterns" in plan) || plan.patterns === undefined) continue;
      plan = await enable(plan.patterns, keys, provider);
    }
    return plan;
  }

  return { disable, enable, prune, resync, providerKeys, everyKey };
}

/**
 * The least change to `enabledModels` for one edit (M7R54..56). `current` is the list as Pi reads it. Pi's own matcher
 * decides what every entry enables, and the result is checked against it before it is returned: an entry that covers
 * no switched-off model stays verbatim, an unmatched entry stays unless `prune`, and `clear` removes the key.
 */
export async function planEnabledEdit(
  current: readonly string[] | undefined,
  op: EnabledOp,
  catalog: CatalogFacts,
): Promise<EnabledPlan> {
  const planner = makePlanner(catalog);
  const list = current ?? [];
  const keep = (): EnabledPlan => ({ patterns: current === undefined ? undefined : [...current] });
  switch (op.op) {
    case "clear":
      return { patterns: undefined };
    case "prune":
      return list.length === 0 ? keep() : planner.prune(list);
    case "resync":
      return list.length === 0 ? keep() : planner.resync(list, op.providers);
    case "provider": {
      const keys = planner.providerKeys.get(op.provider);
      if (!keys) return keep();
      if (op.enabled && list.length === 0) return keep();
      return op.enabled ? planner.enable(list, keys, op.provider) : planner.disable(list, new Set(keys));
    }
    case "toggle": {
      const key = `${op.provider}/${op.modelId}`;
      if (!planner.providerKeys.get(op.provider)?.includes(key)) return keep();
      if (op.enabled && list.length === 0) return keep();
      return op.enabled ? planner.enable(list, [key], op.provider) : planner.disable(list, new Set([key]));
    }
  }
}

type Params = z.infer<(typeof HELPER_OPS)["models.setEnabled"]["params"]>;
type Result = z.infer<(typeof HELPER_OPS)["models.setEnabled"]["result"]>;

export const setEnabled: HelperOp<Params, Result> = {
  params: HELPER_OPS["models.setEnabled"].params,
  run: async (params, ctx) => {
    const runtime = await openRuntime(ctx);
    const models = runtime.getModels().map(({ provider, id, name }) => ({ provider, id, name }));
    const { op } = params;
    if (op.op === "toggle" && !runtime.getModel(op.provider, op.modelId))
      throw new HelperOpError("not_found", "model");
    if (op.op === "provider" && !models.some((model) => model.provider === op.provider))
      throw new HelperOpError("not_found", "provider");
    const settings = await settingsToWrite(ctx, ["enabledModels"]);
    const current: unknown = settings.manager.getEnabledModels();
    if (current !== undefined && !(Array.isArray(current) && current.every((p) => typeof p === "string")))
      throw new HelperOpError("config_invalid", "enabledModels");
    const plan = await planEnabledEdit(current as string[] | undefined, op, { models }).catch(
      (error: unknown) => {
        if (error instanceof PlanMismatch) throw new HelperOpError("failed", error.message);
        throw error;
      },
    );
    if ("refused" in plan) throw new HelperOpError("conflict", plan.refused);
    if (same(plan.patterns, current as string[] | undefined)) return { patterns: plan.patterns ?? null };
    await guardSettingsWrite(ctx);
    settings.manager.setEnabledModels(plan.patterns);
    await commit(settings);
    return { patterns: plan.patterns ?? null };
  },
};

export const setEnabledOp = defineOp(setEnabled);
