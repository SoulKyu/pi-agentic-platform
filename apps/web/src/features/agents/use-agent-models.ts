import { useEffect, useState } from "react";
import { getRuntime } from "../../runtime/index.ts";
import type { ModelChoice } from "./model-fields.vm.ts";

/**
 * The models the owner has enabled (`models.overview`, no folder: an agent has no project). While loading, and when the
 * list cannot be read, only the default model is on offer; `failed` says so.
 */
export interface AgentModels {
  readonly choices: readonly ModelChoice[];
  readonly failed: boolean;
  /** The daemon left providers out of the list to stay within its budget. */
  readonly truncated: boolean;
}

export function useAgentModels(): AgentModels {
  const [state, setState] = useState<AgentModels>({ choices: [], failed: false, truncated: false });
  useEffect(() => {
    let live = true;
    getRuntime()
      .rpc.call("models.overview", {})
      .then(
        (overview) => {
          if (!live) return;
          const choices = overview.providers.flatMap((provider) =>
            provider.models
              .filter((model) => model.enabled)
              .map((model) => ({
                provider: model.provider,
                id: model.id,
                name: model.name,
                reasoning: model.reasoning,
              })),
          );
          setState({ choices, failed: false, truncated: overview.truncated });
        },
        () => live && setState({ choices: [], failed: true, truncated: false }),
      );
    return () => {
      live = false;
    };
  }, []);
  return state;
}
