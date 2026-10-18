import type { ExtensionProviders } from "@pap/contracts";

/**
 * The extension providers on the owner's click (MPR17). The helper runs the owner's own extension code, so clicks that
 * arrive while a run is in flight share it instead of starting another, unless a write of Pi's files landed since that
 * run started (`invalidate`): its marks (`enabled`, `offered`) may predate the write, so a later read starts its own.
 * Nothing is kept afterwards, the answer included. A helper error is passed on.
 */
export function createExtensionProviders(deps: { ask(): Promise<ExtensionProviders> }) {
  let generation = 0;
  let pending: { readonly run: Promise<ExtensionProviders>; readonly generation: number } | undefined;
  return {
    get(): Promise<ExtensionProviders> {
      if (pending !== undefined && pending.generation === generation) return pending.run;
      const started = { generation, run: deps.ask() };
      pending = started;
      void started.run
        .finally(() => {
          if (pending === started) pending = undefined;
        })
        .catch(() => {});
      return started.run;
    },
    /** A write of Pi's files settled: a read from now on starts a run of its own. */
    invalidate(): void {
      generation += 1;
    },
  };
}
