import type { ExtensionProviders } from "@pap/contracts";

/**
 * The extension providers on the owner's click (MPR17). The helper runs the owner's own extension code, so clicks that
 * arrive while a run is in flight share it instead of starting another. Nothing is kept afterwards, the answer
 * included: the next click loads the extensions again and sees what they register now. A helper error is passed on.
 */
export function createExtensionProviders(deps: { ask(): Promise<ExtensionProviders> }) {
  let pending: Promise<ExtensionProviders> | undefined;
  return {
    get(): Promise<ExtensionProviders> {
      if (pending !== undefined) return pending;
      const run = deps.ask().finally(() => {
        pending = undefined;
      });
      pending = run;
      return run;
    },
  };
}
