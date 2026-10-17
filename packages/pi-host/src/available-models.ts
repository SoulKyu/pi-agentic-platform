import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ModelRuntime,
  resolveModelScopeWithDiagnostics,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";

export type AvailabilityOrigin = "session" | "scope" | "signed-in";
export interface Availability {
  readonly models: readonly Model<Api>[];
  readonly origin: AvailabilityOrigin;
}

/**
 * The models a context may use, in Pi's order (M7R41): the session's own scope, else the scope `enabledModels` names
 * (resolved by Pi against the runtime's available list), else everything the runtime has credentials for. A scope
 * that resolves to nothing (patterns naming only unsigned or unknown models) does not hide the signed-in list.
 */
export async function listAvailable(
  runtime: ModelRuntime,
  patterns: readonly string[] | undefined,
  sessionScope?: ReadonlyArray<{ readonly model: Model<Api> }>,
): Promise<Availability> {
  if (sessionScope !== undefined && sessionScope.length > 0)
    return { models: sessionScope.map((scoped) => scoped.model), origin: "session" };
  if (patterns !== undefined && patterns.length > 0) {
    const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], runtime);
    if (scopedModels.length > 0)
      return { models: scopedModels.map((scoped) => scoped.model), origin: "scope" };
  }
  return { models: await runtime.getAvailable(), origin: "signed-in" };
}

/**
 * A warm worker re-reads what the helper reads fresh (MPR25): Pi's SettingsManager caches `enabledModels` until
 * `reload()` and its ModelRuntime does not see an edited models.json until `refresh()`. Both calls are offline. A run in
 * flight keeps the snapshot it started with (a model switch is refused while it runs, M7R43).
 */
export async function freshAvailable(
  runtime: ModelRuntime,
  settings: Pick<SettingsManager, "reload" | "getEnabledModels">,
  sessionScope: ReadonlyArray<{ readonly model: Model<Api> }> | undefined,
  idle: boolean,
): Promise<Availability> {
  if (idle) {
    await settings.reload();
    await runtime.refresh({ allowNetwork: false });
  }
  return listAvailable(runtime, settings.getEnabledModels(), sessionScope);
}
